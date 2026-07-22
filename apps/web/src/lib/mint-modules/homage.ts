/**
 * Homage ("Homage to the Punk") collection module — everything Homage-specific
 * behind the generic `/mint/[contract]` surface, registered against the Phase-2
 * machinery (mint-registries.ts). The descriptor factory at the bottom is
 * consumed by mint-collections.ts, whose import of this module also runs the
 * provider registrations (the side-effect pattern mint-registries.ts documents).
 *
 * What Homage is: a redeemable, $111-backed Albers homage per CryptoPunk
 * (`tokenId == punkId`, supply 10,000). `mint()` swaps the sent ETH into
 * ≥ 50,000 $111 on the live Uniswap v4 pool and escrows exactly 50,000 inside
 * the new token; `redeem(id)` burns it, returns the coins, and puts the punk
 * id back in the mintable pool. Three sequential owner-scheduled windows share
 * the same economics: claim (punk holders mint their own id), allowlist
 * (merkle-gated random draw), public (anyone, per-wallet escalating fee).
 *
 * SOVEREIGN TWO-CONTRACT SHAPE: Homage was rebuilt from a single monolith
 * into `HomageMinter` (the mint engine — writes, economics, schedule,
 * allowlist, supply, redeem) minting INTO a separate pooled PND Collection
 * (the ERC-721 — ownerOf/balanceOf/tokenURI/Transfer only). Every read/write
 * below targets whichever address actually holds that state: mint/claim/
 * redeem/economics/schedule/allowlist/reveal all hit `HOMAGE_MINTER_ADDRESS`;
 * ownership/tokenURI/Transfer hit `HOMAGE_COLLECTION_ADDRESS` via the
 * descriptor's `tokenContract` field (mint-collections.ts / mint-onchain.ts).
 * The renderer (`HOMAGE_RENDERER`) was already a third, separate address in
 * this descriptor pre-rebuild (a sample/preview render, not the collection's
 * own tokenURI) and is unaffected by the split.
 *
 * Ported (not reinvented) from the Homage repo working tree
 * (/Users/dd/CascadeProjects/homage to the punk, sovereign-rebuild branch):
 * quote math from `web/lib/homage.ts` (the pure scaling lives in
 * ../homage-quote-math.ts), ownership checks from `web/lib/useHomageMint.ts`,
 * proofs from `web/lib/allowlist.ts`. The merkle artifact is vendored
 * BYTE-IDENTICAL — see the comment on the import below.
 *
 * RPC discipline (per call site):
 *   - quote provider: 1 multicall (slot0 + fee) + 1 quoter eth_call, refreshed
 *     by useMintQuote at ttlMs 30s, visibility-gated — never per render.
 *   - claim eligibility: 1 read + ≤2 multicalls, once per (wallet, phase).
 *     WrappedPunks is ERC721Enumerable so the wallet's wrapped punks enumerate
 *     exactly; there is deliberately NO raw-punk log scan (no cheap onchain
 *     enumeration exists for the 2017 market) — raw holders use the picker's
 *     manual id input, verified per id on an explicit user action.
 *   - allowlist eligibility: 1 multicall, once per (wallet, phase).
 *   - args builders: zero RPC (shape client-held data into calldata).
 */

import { isAddress, parseAbi, zeroAddress, zeroHash, type Address, type PublicClient } from "viem"
import { homageMinterAbi, homageCollectionAbi, homageRendererAbi } from "@pin/abi"
import type { Abi } from "viem"
import type { MintCollection } from "../mint-collections"
import {
  registerArgsBuilder,
  registerEligibilityProvider,
  registerQuoteProvider,
} from "../mint-registries"
import {
  DEFAULT_SAFETY_BPS,
  scaleSwapForThreshold,
  spotEthForThreshold,
} from "../homage-quote-math"
// Allowlist proofs load LAZILY through the canonical module (lib/homage/allowlist):
// with every punk holder on the list the proof file is ~3.6MB, far too big to bake
// into the bundle. Both surfaces share one fetch + cache.
import {allowlistProofIn, loadAllowlist} from "@/lib/homage/allowlist"

// ── canonical mainnet addresses (mirrors the Homage repo's web/lib/homage.ts) ─
// Opt-in sepolia instance (mirrors mint-collections.ts' MINT_CHAIN_ID split):
// swaps these for the live sepolia deployment's stand-in contracts. A no-op
// when unset — mainnet addresses are unchanged.
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"

/** The $111 coin escrowed inside each homage. Sepolia: Mock111, an open-mint
 *  faucet token standing in for the real $111. */
export const TOKEN_111: Address = USE_SEPOLIA
  ? "0x27b862985ddcf75c5dba649549a26657332124c4"
  : "0x61C9d89fe1212F6b55fF888816A151463287B8ae"
/** The live ETH/$111 v4 pool id Homage mints swap through (read for quoting).
 *  Mainnet only — sepolia has no v4 pool; see MOCK_POOL_MANAGER below. */
export const HOMAGE_POOL_ID =
  "0xf860d8f4896aed6cc1c68d234ba728680902f0ae43a459fbee6f6baa8036f795" as const
/** v4 periphery (canonical mainnet deployments, mainnet only). */
export const V4_STATE_VIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227" as const
export const V4_QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" as const
const SKIM_HOOK = "0x636c050296B5Cc528D8785169Bf8923716FCa9cc" as const
const DYN_FEE = 0x800000 // dynamic-fee flag (matches the pool Homage was wired with)
const TICK_SPACING = 200
const POOL_KEY = {
  currency0: zeroAddress, // native ETH
  currency1: TOKEN_111,
  fee: DYN_FEE,
  tickSpacing: TICK_SPACING,
  hooks: SKIM_HOOK,
} as const

/** Sepolia stand-in for the v4 pool: a hookless mock that mints TOKEN_111 to
 *  the caller for a flat ETH cost per swap (no StateView/Quoter, no price
 *  curve) — see the `weiPerSwap` read in the homage-quote provider below. */
const MOCK_POOL_MANAGER = "0xf99a9c7d61047cd8b6d34e88c803d25a4162b41b" as const
const mockPoolManagerAbi = parseAbi(["function weiPerSwap() view returns (uint256)"])

/** CryptoPunks contracts — the claim window's ownership sources, mirroring
 *  Homage._isPunkHolder: raw ownership is the market's `punkIndexToAddress`;
 *  a wrapped punk reports the wrapper as owner, so the true holder is the
 *  wrapper's `ownerOf`. Sepolia: MockPunksMarket stands in for the market
 *  (settable punkIndexToAddress); WrappedPunks has no sepolia deployment, so
 *  the wrapped-punks read is skipped there (see HAS_WRAPPED_PUNKS below). */
export const CRYPTOPUNKS_MARKET: Address = USE_SEPOLIA
  ? "0x1034699aa91c9e48765a1212ac1dccfac75a6882"
  : "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB"
export const WRAPPED_PUNKS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6" as const
/** WrappedPunks isn't deployed on sepolia; every code path that would read it
 *  (balanceOf/tokenOfOwnerByIndex/ownerOf) is gated on this instead of
 *  letting the call revert against an empty address. */
const HAS_WRAPPED_PUNKS = !USE_SEPOLIA

/** delegate.xyz v2 registry (canonical, same address on mainnet and sepolia)
 *  — Homage.claimFor accepts a delegate of the punk's holder (empty rights),
 *  mirroring the Homage site. */
export const DELEGATE_REGISTRY = "0x00000000000000447e69651d841bD8D104Bed493" as const
const delegateRegistryAbi = parseAbi([
  "struct Delegation { uint8 type_; address to; address from; bytes32 rights; address contract_; uint256 tokenId; uint256 amount; }",
  "function checkDelegateForERC721(address to, address from, address contract_, uint256 tokenId, bytes32 rights) view returns (bool)",
  "function getIncomingDelegations(address to) view returns (Delegation[] delegations)",
])

// Aux read-only ABIs — module-private plumbing for external canonical
// contracts (not PND adapters), so they live here rather than @pin/abi.
const punksMarketAbi = parseAbi([
  "function punkIndexToAddress(uint256 index) view returns (address)",
])
const wrappedPunksAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
])
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
])
// The quoter isn't a `view` in the ABI but is designed to be eth_call'd;
// readContract simulates it fine (same note as the Homage repo).
const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
])

// ── env-driven addresses ──────────────────────────────────────────────────────
// LITERAL `process.env.NEXT_PUBLIC_*` reads (build-time inlining — a dynamic
// lookup stays undefined client-side and silently drops the descriptor). ALL
// THREE must be present + valid for the venue to register; unsetting any one
// is the launch rollback lever (the whole /mint/homage surface disappears
// cleanly). Two addresses are the sovereign-rebuild split (was one monolith):
//   HOMAGE_MINTER     — HomageMinter: mint/claim/redeem, economics, schedule,
//                       allowlist, supply, isMinted, reveal. The descriptor's
//                       primary `contract` — what MintPanel actually mints on.
//   HOMAGE_COLLECTION — the pooled PND Collection (the ERC-721): ownerOf,
//                       balanceOf, tokenURI, Transfer. Threaded through the
//                       descriptor's `tokenContract` field.
// HOMAGE_RENDERER was already a third, separate address pre-rebuild (a
// sample/preview render of any punk id, not the collection's own tokenURI)
// and is unaffected by the split.
const HOMAGE_MINTER_ADDRESS = process.env.NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS
const HOMAGE_COLLECTION_ADDRESS = process.env.NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS
const HOMAGE_RENDERER = process.env.NEXT_PUBLIC_HOMAGE_RENDERER

/** Sample punk rendered as the collection hero (any id renders — the art is
 *  abstract either way; one of the Homage site's cycling hero samples). */
const HERO_SAMPLE_PUNK_ID = 3542n

// ── allowlist proofs (lazy — see lib/homage/allowlist) ────────────────────────

/** The Merkle proof for `address`, or null if it isn't on the allowlist. */
export async function allowlistProofFor(address: string): Promise<`0x${string}`[] | null> {
  return allowlistProofIn(await loadAllowlist(), address)
}

/** Format an 18-decimal token amount as a whole-number, comma-grouped string
 *  for a breakdown label (e.g. `30000n * WAD` -> "30,000"). Threshold values
 *  are always whole-token amounts. */
function formatWholeToken(amountWad: bigint): string {
  const whole = amountWad / 10n ** 18n
  return whole.toLocaleString("en-US")
}

// ── quote provider: "homage-quote" ────────────────────────────────────────────
// One provider serves all three phases. Every window now folds in the caller's
// escalating `mintFeeOf(wallet)` (claims and allowlist mints escalate on the same
// per-wallet counter as public — the claim privilege is choosing your own id, not a
// fee discount). Throwing (quoter revert, thin pool) disables the mint button with
// the reason, per the registry contract.

registerQuoteProvider("homage-quote", async ({ client, wallet, phaseKey }) => {
  if (!HOMAGE_MINTER_ADDRESS || !isAddress(HOMAGE_MINTER_ADDRESS))
    throw new Error("Homage is not configured")
  const minter = HOMAGE_MINTER_ADDRESS as Address

  // Sepolia: MOCK_POOL_MANAGER has no StateView/Quoter to probe — it mints
  // TOKEN_111 to the caller for a flat ETH cost per swap (`weiPerSwap`, read
  // live rather than hardcoded so a mock redeploy at a different price needs
  // no frontend change). No headroom/refund math applies to a flat price.
  if (USE_SEPOLIA) {
    const [feeRes, weiPerSwapRes, thresholdRes] = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: minter, abi: homageMinterAbi as Abi, functionName: "mintFeeOf", args: [wallet ?? zeroAddress] },
        { address: MOCK_POOL_MANAGER, abi: mockPoolManagerAbi, functionName: "weiPerSwap" },
        { address: minter, abi: homageMinterAbi as Abi, functionName: "threshold" },
      ],
    })
    if (feeRes.status !== "success") throw new Error("mint fee unavailable")
    if (weiPerSwapRes.status !== "success") throw new Error("sepolia mock pool quote unavailable")
    const fee = feeRes.result as bigint
    const ethForSwap = weiPerSwapRes.result as bigint
    const value = ethForSwap + fee
    const thresholdLabel =
      thresholdRes.status === "success" ? formatWholeToken(thresholdRes.result as bigint) : "the escrow threshold of"
    return {
      value,
      breakdown: [
        { label: `Buys ${thresholdLabel} $111 (sepolia mock pool, flat price)`, wei: ethForSwap },
        { label: "Mint fee (this wallet)", wei: fee },
        { label: "Total", wei: value },
      ],
      note: "Sepolia mock pool: flat price, no slippage headroom or refund",
      ttlMs: 30_000,
    }
  }

  // Pool spot + the phase's ETH fee + the live escrow threshold in one
  // multicall. Threshold and fee reads hit the MINTER — economics live
  // there, not the collection. `threshold` is owner-tunable
  // (`HomageMinter.setThreshold`), so it must be read live rather than
  // hardcoded: a stale constant here previously sized every swap for
  // 50,000 $111 against a deployed threshold of 30,000.
  const [slot0Res, feeRes, thresholdRes] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: V4_STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [HOMAGE_POOL_ID] },
      { address: minter, abi: homageMinterAbi as Abi, functionName: "mintFeeOf", args: [wallet ?? zeroAddress] },
      { address: minter, abi: homageMinterAbi as Abi, functionName: "threshold" },
    ],
  })
  if (slot0Res.status !== "success") throw new Error("pool price unavailable")
  if (feeRes.status !== "success") throw new Error("mint fee unavailable")
  if (thresholdRes.status !== "success") throw new Error("escrow threshold unavailable")
  const sqrtP = (slot0Res.result as readonly [bigint, number, number, number])[0]
  const fee = feeRes.result as bigint
  const threshold = thresholdRes.result as bigint

  // Size the probe from spot, then run ONE real quote through the live pool
  // (LP fee + skim + price impact all reflected) and scale linearly to clear
  // threshold + 5%. Excess $111/ETH is refunded by the contract.
  const probe = (() => {
    const spot = spotEthForThreshold(sqrtP, threshold) // throws "pool not initialized" on 0
    return spot > 0n ? spot : 10n ** 15n
  })()
  const [probeOut] = (await client.readContract({
    address: V4_QUOTER,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: POOL_KEY, zeroForOne: true, exactAmount: probe, hookData: "0x" }],
  })) as readonly [bigint, bigint]
  const { ethForSwap } = scaleSwapForThreshold(probe, probeOut, threshold, DEFAULT_SAFETY_BPS)

  const value = ethForSwap + fee
  return {
    value,
    breakdown: [
      { label: `Buys ${formatWholeToken(threshold)} $111`, wei: ethForSwap },
      { label: "Mint fee (this wallet)", wei: fee },
      { label: "Total", wei: value },
    ],
    note: "Includes 5% headroom; excess $111 and leftover ETH are refunded",
    ttlMs: 30_000,
  }
})

// ── claim phase: eligibility + args ("homage-claim") ─────────────────────────
// Full claim-routing parity with the Homage site (Homage.sol's three paths):
//   claim(id)          — the connected wallet holds the punk (raw or wrapped)
//   claimFor(id,vault) — a delegate.xyz delegate mints; the homage goes to the vault
//   claimTo(id)        — anyone pays; the homage mints to the punk's holder

/** How a claim routes — mirrors the write path Homage.sol accepts for it. */
export type HomageClaimRoute =
  | { via: "self" }
  | { via: "delegated"; vault: Address }
  | { via: "anyone"; holder: Address }

/** The claim picker's selection: which punk, and through which route. */
export type HomageClaimSelection = { id: number; route: HomageClaimRoute }

/** One claimable punk offered by the picker. `vault` set = delegated (mints
 *  to the vault via claimFor). */
export type HomagePunkPick = { id: number; wrapped: boolean; vault?: Address }

/** The claim eligibility payload handed to the HomagePunkPicker selector. */
export type HomageClaimData = { punks: HomagePunkPick[] }

// Vault-wide delegations enumerated per connect, RPC-bounded (mirrors the
// Homage site's MAX_DELEGATION_VAULTS).
const MAX_DELEGATION_VAULTS = 4

/** The wallet's wrapped punks (ERC721Enumerable — exact, no log scan):
 *  1 read + ≤1 multicall. Sepolia has no WrappedPunks deployment; skipped via
 *  HAS_WRAPPED_PUNKS rather than reading against an empty address. */
async function wrappedPunksOf(client: PublicClient, who: Address): Promise<bigint[]> {
  if (!HAS_WRAPPED_PUNKS) return []
  const bal = (await client.readContract({
    address: WRAPPED_PUNKS,
    abi: wrappedPunksAbi,
    functionName: "balanceOf",
    args: [who],
  })) as bigint
  if (bal === 0n) return []
  const idxReads = await client.multicall({
    allowFailure: true,
    contracts: Array.from({ length: Number(bal) }, (_, i) => ({
      address: WRAPPED_PUNKS,
      abi: wrappedPunksAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [who, BigInt(i)] as const,
    })),
  })
  return idxReads.filter((r) => r.status === "success").map((r) => r.result as bigint)
}

/** Incoming delegate.xyz delegations relevant to punk claims (1 read): vaults
 *  that delegated `who` wallet-wide or for a punk contract, plus token-level
 *  (id, vault) candidates. Rights-scoped delegations are skipped —
 *  Homage.claimFor checks empty rights. Mirrors the Homage site. */
async function claimDelegations(
  client: PublicClient,
  who: Address,
): Promise<{ vaults: Address[]; tokens: { id: bigint; vault: Address }[] }> {
  const raw = (await client.readContract({
    address: DELEGATE_REGISTRY,
    abi: delegateRegistryAbi,
    functionName: "getIncomingDelegations",
    args: [who],
  })) as readonly {
    type_: number
    to: Address
    from: Address
    rights: `0x${string}`
    contract_: Address
    tokenId: bigint
    amount: bigint
  }[]
  const isPunkSource = (c: string) =>
    c.toLowerCase() === CRYPTOPUNKS_MARKET.toLowerCase() || c.toLowerCase() === WRAPPED_PUNKS.toLowerCase()
  const vaults = new Set<Address>()
  const tokens: { id: bigint; vault: Address }[] = []
  for (const d of raw) {
    if (d.rights !== zeroHash) continue
    // DelegationType: 1 = ALL, 2 = CONTRACT, 3 = ERC721
    if (d.type_ === 1 || (d.type_ === 2 && isPunkSource(d.contract_))) vaults.add(d.from)
    else if (d.type_ === 3 && isPunkSource(d.contract_) && d.tokenId <= 9_999n) tokens.push({ id: d.tokenId, vault: d.from })
  }
  return { vaults: Array.from(vaults).slice(0, MAX_DELEGATION_VAULTS), tokens }
}

registerEligibilityProvider("homage-claim", async ({ client, wallet }) => {
  if (!HOMAGE_MINTER_ADDRESS || !isAddress(HOMAGE_MINTER_ADDRESS))
    throw new Error("Homage is not configured")
  if (!wallet) {
    return { eligible: false, reason: "Connect the wallet that holds your punk." }
  }
  const minter = HOMAGE_MINTER_ADDRESS as Address

  // Wrapped punks held directly: ERC721Enumerable, so balanceOf +
  // tokenOfOwnerByIndex lists them exactly — no log scan. (The market reports
  // the wrapper as the raw owner for these; claim() resolves the true holder
  // through the wrapper.)
  const ownIds = await wrappedPunksOf(client, wallet)

  // Delegated punks (delegate.xyz, 1 read): vaults that delegated this wallet
  // contribute their WRAPPED punks (enumerable — raw vault punks fall through
  // to the manual-id entry, same no-log-scan stance as the wallet's own);
  // token-level delegations are verified individually below.
  let candidates: { id: bigint; wrapped: boolean; vault?: Address }[] = ownIds.map((id) => ({
    id,
    wrapped: true,
  }))
  try {
    const { vaults, tokens } = await claimDelegations(client, wallet)
    for (const vault of vaults) {
      const vIds = await wrappedPunksOf(client, vault)
      for (const id of vIds) candidates.push({ id, wrapped: true, vault })
    }
    if (tokens.length > 0) {
      // Token-level delegations name (id, vault) directly — confirm the vault
      // still holds each punk (raw owner, or wrapper ownerOf) in ≤2 multicalls.
      const ownerReads = await client.multicall({
        allowFailure: true,
        contracts: tokens.map((t) => ({
          address: CRYPTOPUNKS_MARKET,
          abi: punksMarketAbi,
          functionName: "punkIndexToAddress",
          args: [t.id] as const,
        })),
      })
      const wrappedIdx = tokens.filter(
        (_, i) =>
          ownerReads[i]?.status === "success" &&
          (ownerReads[i].result as Address).toLowerCase() === WRAPPED_PUNKS.toLowerCase(),
      )
      const wrappedOwnerReads =
        wrappedIdx.length > 0
          ? await client.multicall({
              allowFailure: true,
              contracts: wrappedIdx.map((t) => ({
                address: WRAPPED_PUNKS,
                abi: wrappedPunksAbi,
                functionName: "ownerOf",
                args: [t.id] as const,
              })),
            })
          : []
      tokens.forEach((t, i) => {
        const ownerRes = ownerReads[i]
        if (ownerRes?.status !== "success") return
        const rawOwner = (ownerRes.result as Address).toLowerCase()
        if (rawOwner === t.vault.toLowerCase()) {
          candidates.push({ id: t.id, wrapped: false, vault: t.vault })
        } else if (rawOwner === WRAPPED_PUNKS.toLowerCase()) {
          const wi = wrappedIdx.indexOf(t)
          const holderRes = wrappedOwnerReads[wi]
          if (
            holderRes?.status === "success" &&
            (holderRes.result as Address).toLowerCase() === t.vault.toLowerCase()
          ) {
            candidates.push({ id: t.id, wrapped: true, vault: t.vault })
          }
        }
      })
    }
  } catch {
    // Delegation discovery is best-effort — the manual-id path (which checks
    // delegation per id) still covers a delegate whose discovery read failed.
  }

  // Dedupe (a punk may arrive held AND token-delegated) — held wins.
  const seen = new Set<number>()
  candidates = candidates
    .sort((a, b) => Number(a.vault ? 1 : 0) - Number(b.vault ? 1 : 0))
    .filter((c) => {
      const n = Number(c.id)
      if (seen.has(n)) return false
      seen.add(n)
      return true
    })

  // Filter to punks whose homage is still unminted (tokenId == punkId).
  // isMinted is the minter's escrow-backed record, not a collection read.
  let punks: HomagePunkPick[] = []
  if (candidates.length > 0) {
    const mintedReads = await client.multicall({
      allowFailure: true,
      contracts: candidates.map((c) => ({
        address: minter,
        abi: homageMinterAbi as Abi,
        functionName: "isMinted",
        args: [c.id] as const,
      })),
    })
    punks = candidates
      .filter((_, i) => mintedReads[i]?.status === "success" && mintedReads[i].result === false)
      .map((c) => ({ id: Number(c.id), wrapped: c.wrapped, vault: c.vault }))
      .sort((a, b) => a.id - b.id)
  }

  // Raw punks can't be enumerated cheaply (the 2017 market isn't ERC-721 and
  // we don't log-scan), so a wallet with no offered punks is still ELIGIBLE:
  // the picker's manual id input verifies ownership/delegation per id — and
  // claimTo() lets ANYONE pay for a holder's homage, so the window is open to
  // every wallet.
  const delegatedCount = punks.filter((p) => p.vault).length
  const data: HomageClaimData = { punks }
  return {
    eligible: true,
    reason:
      punks.length > 0
        ? `${punks.length} punk${punks.length === 1 ? "" : "s"} with an unminted homage${delegatedCount > 0 ? ` (${delegatedCount} via delegation)` : ""}.`
        : "No wrapped punks with an unminted homage found for this wallet. Hold or manage a raw punk? Enter its id below.",
    data,
  }
})

registerArgsBuilder("homage-claim", ({ selection }) => {
  // Back-compat: a bare number routes as the holder's own claim.
  const sel: HomageClaimSelection | null =
    typeof selection === "number" && Number.isInteger(selection)
      ? { id: selection, route: { via: "self" } }
      : selection && typeof selection === "object" && "id" in selection
        ? (selection as HomageClaimSelection)
        : null
  if (!sel || sel.id < 0 || sel.id > 9999) throw new Error("Pick the punk to claim first")
  const id = BigInt(sel.id)
  switch (sel.route.via) {
    case "delegated":
      return { fn: "claimFor", args: [id, sel.route.vault] }
    case "anyone":
      return { fn: "claimTo", args: [id] }
    default:
      return { fn: "claim", args: [id] }
  }
})

/**
 * Verify punk `id` is claimable through `wallet` (mirrors Homage's three claim
 * paths) and that its homage is unminted — the picker's manual-id path, fired
 * ONLY on an explicit user action (never per keystroke/render). 1 multicall +
 * ≤2 reads.
 *
 * Resolution order matches Homage.sol: the wallet holds it (claim) → the
 * holder delegated the wallet via delegate.xyz (claimFor, mints to the vault)
 * → anyone pays (claimTo, mints to the holder).
 */
export async function verifyPunkClaimable(
  client: PublicClient,
  id: number,
  wallet: Address,
): Promise<{ ok: boolean; reason?: string; wrapped?: boolean; route?: HomageClaimRoute }> {
  if (!HOMAGE_MINTER_ADDRESS || !isAddress(HOMAGE_MINTER_ADDRESS))
    return { ok: false, reason: "not configured" }
  const minter = HOMAGE_MINTER_ADDRESS as Address
  const [ownerRes, mintedRes] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, functionName: "punkIndexToAddress", args: [BigInt(id)] },
      { address: minter, abi: homageMinterAbi as Abi, functionName: "isMinted", args: [BigInt(id)] },
    ],
  })
  if (ownerRes.status !== "success" || mintedRes.status !== "success")
    return { ok: false, reason: "couldn't check ownership. Try again" }
  if (mintedRes.result === true) return { ok: false, reason: `#${id} has already been minted` }
  const rawOwner = ownerRes.result as Address
  if (rawOwner === zeroAddress) return { ok: false, reason: `couldn't resolve #${id}'s holder` }
  const wrapped = rawOwner.toLowerCase() === WRAPPED_PUNKS.toLowerCase()

  // The true holder: the raw owner, or the wrapper's ownerOf — one extra read.
  let holder = rawOwner
  if (wrapped) {
    try {
      holder = (await client.readContract({
        address: WRAPPED_PUNKS,
        abi: wrappedPunksAbi,
        functionName: "ownerOf",
        args: [BigInt(id)],
      })) as Address
    } catch {
      return { ok: false, reason: "couldn't check the wrapper. Try again" }
    }
  }
  if (holder.toLowerCase() === wallet.toLowerCase()) {
    return { ok: true, wrapped, route: { via: "self" } }
  }

  // Not the holder — delegate.xyz next (hierarchical check, keyed against the
  // contract ownership lives in, mirroring Homage.claimFor). One read.
  const source = wrapped ? WRAPPED_PUNKS : CRYPTOPUNKS_MARKET
  try {
    const delegated = (await client.readContract({
      address: DELEGATE_REGISTRY,
      abi: delegateRegistryAbi,
      functionName: "checkDelegateForERC721",
      args: [wallet, holder, source, BigInt(id), zeroHash],
    })) as boolean
    if (delegated) return { ok: true, wrapped, route: { via: "delegated", vault: holder } }
  } catch {
    // fall through to the permissionless path
  }

  // Permissionless: anyone pays, the homage mints to the holder (claimTo).
  return { ok: true, wrapped, route: { via: "anyone", holder } }
}

/**
 * Does this write failure look like Homage's `Slippage(received, needed)`
 * revert (the pool moved between quote and mine)? Walks the viem cause chain —
 * the decoded custom-error name is usually 2-3 levels deep.
 */
export function isSlippageError(e: unknown): boolean {
  let cur: unknown = e
  for (let depth = 0; cur && depth < 6; depth++) {
    if (cur instanceof Error) {
      if (/\bSlippage\b/.test(cur.message)) return true
      cur = (cur as Error & { cause?: unknown }).cause
    } else {
      return typeof cur === "string" && /\bSlippage\b/.test(cur)
    }
  }
  return false
}

// ── allowlist phase: eligibility + args ("homage-allowlist") ─────────────────

type HomageAllowlistData = { proof: `0x${string}`[] }

registerEligibilityProvider("homage-allowlist", async ({ client, wallet }) => {
  if (!HOMAGE_MINTER_ADDRESS || !isAddress(HOMAGE_MINTER_ADDRESS))
    throw new Error("Homage is not configured")
  if (!wallet) return { eligible: false, reason: "Connect a wallet to check the allowlist." }
  const proofData = await loadAllowlist()
  const proof = allowlistProofIn(proofData, wallet)
  if (!proof) return { eligible: false, reason: "This wallet is not on the allowlist." }
  const minter = HOMAGE_MINTER_ADDRESS as Address

  // Root sanity check, once per wallet+phase. There is no per-wallet allowance to read:
  // allowlist mints are uncapped and throttled only by the fee escalator.
  const [rootRes] = await client.multicall({
    allowFailure: true,
    contracts: [{ address: minter, abi: homageMinterAbi as Abi, functionName: "allowlistRoot" }],
  })
  // Guard against a rotated onchain root: baked proofs would revert with
  // NotAllowlisted, so fail the check with an honest reason instead.
  if (rootRes.status === "success" && (rootRes.result as string) !== proofData.root) {
    return {
      eligible: false,
      reason: "The onchain allowlist root doesn't match this build's proofs. Mint on the Homage site.",
    }
  }
  const data: HomageAllowlistData = { proof }
  return {
    eligible: true,
    reason: "On the allowlist. A random punk is drawn at mint.",
    data,
  }
})

registerArgsBuilder("homage-allowlist", ({ eligibilityData }) => {
  const proof = (eligibilityData as HomageAllowlistData | undefined)?.proof
  if (!proof) throw new Error("Allowlist proof unavailable. Reconnect your wallet")
  return [proof]
})

// ── descriptor factory (consumed by mint-collections.ts) ─────────────────────

export function homageCollection(chainId: number): MintCollection | null {
  if (!HOMAGE_MINTER_ADDRESS || !isAddress(HOMAGE_MINTER_ADDRESS)) return null
  if (!HOMAGE_COLLECTION_ADDRESS || !isAddress(HOMAGE_COLLECTION_ADDRESS)) return null
  if (!HOMAGE_RENDERER || !isAddress(HOMAGE_RENDERER)) return null
  return {
    slug: "homage",
    name: "Homage to the Punk",
    description:
      "Redeemable, $111-backed homages to the CryptoPunks: one per punk, art derived from its pixels. Your ETH is swapped onchain into 50,000 $111 and escrowed inside the piece; redeem any time to burn it and take the coins back out.",
    chainId,
    // The descriptor's primary `contract`: mint/claim/redeem/economics/
    // schedule/allowlist/reveal all live on the MINTER. `/mint/homage`
    // resolves by slug OR this address (resolveMintCollection), so the
    // route's [contract] segment is the minter's address, not the
    // collection's — curated-chrome.ts's literal env read mirrors this.
    address: HOMAGE_MINTER_ADDRESS as Address,
    abi: homageMinterAbi as unknown as Abi,
    // Token-level reads (ownerOf/tokenURI/balanceOf/Transfer) live on the
    // separate pooled PND Collection, not the minter — mint-onchain.ts's
    // getPieceToken/getCollectionArt/getCollectionTokens and the mint
    // engine's reveal extraction all fall back to this field.
    tokenContract: { address: HOMAGE_COLLECTION_ADDRESS as Address, abi: homageCollectionAbi as unknown as Abi },
    mintedFn: "totalMinted", // SUPPLY - remaining: the OUTSTANDING count (redeem decrements)
    cap: { kind: "getter", fn: "SUPPLY" },
    price: { kind: "quote", provider: "homage-quote" },
    window: { kind: "open" }, // superseded by `phases`
    phases: [
      {
        key: "claim",
        label: "Punk owners",
        window: { startFn: "claimStart", endFn: "allowlistStart" },
        mintFn: "claim",
        eligibility: "homage-claim",
        argsBuilder: "homage-claim",
        selector: "homage-claim",
        noun: "homage",
      },
      {
        key: "allowlist",
        label: "Allowlist",
        window: { startFn: "allowlistStart", endFn: "publicStart" },
        mintFn: "allowlistMint",
        eligibility: "homage-allowlist",
        argsBuilder: "homage-allowlist",
      },
      {
        key: "public",
        label: "Public",
        window: { startFn: "publicStart" }, // open-ended
        mintFn: "mint",
      },
    ],
    alreadyMintedFn: null, // repeatable — the public fee escalator is the throttle
    mintFn: "mint",
    quantity: false,
    // Reveal via the standard ERC-721 Transfer(from=0) log: ONE config covers
    // all three phases (the contract's own announce event differs by path —
    // `Claimed` for claims, `Minted` otherwise — and `reveal` is a single
    // collection-level source, while Transfer fires identically for every
    // mint). tokenId == punkId, so the revealed id IS the drawn punk.
    reveal: { kind: "transfer-log" },
    layout: "standard",
    // Homage owns its whole page: the gallery wall (anonymized 10k quilt,
    // rendered locally via the punks SDK — zero RPC) with the mint register
    // in its lockup. components/mint/curated-layouts.tsx registers the
    // component; curated-chrome.ts gives the route its immersive site chrome.
    customLayout: "homage-gallery",
    hero: {
      kind: "renderer-contract",
      address: HOMAGE_RENDERER as Address,
      abi: homageRendererAbi as unknown as Abi,
      fn: "tokenURI",
      tokenId: HERO_SAMPLE_PUNK_ID,
    },
    // The hero is a sample punk's render, so its tokenURI name ("Homage to
    // Punk 3542") must NOT retitle the collection page — keep the
    // descriptor's identity (page.tsx honors this flag).
    identityFromHero: false,
    lifecyclePanel: "homage-redeem",
    tokenNoun: "homage",
    supplyLabel: "outstanding",
    // The art re-renders with the underlying punk's live market status —
    // tokenURI reads are short-TTL cached and never persisted as canonical.
    liveMetadata: { ttlSec: 60 },
    heroAspect: "1 / 1",
    pieceAspect: "1 / 1",
    // Record surfaces (provenance timeline, indexer-first supply/schedule,
    // gallery id list, wallet-owned discovery) read from the homage_* Ponder
    // tables via lib/homage-queries.ts. Every one degrades to the RPC snapshot
    // when the tables are absent (pre-deploy), so this is safe to set now.
    provenanceSource: "homage",
  }
}
