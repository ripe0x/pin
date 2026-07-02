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
 * Ported (not reinvented) from the Homage repo working tree
 * (/Users/dd/CascadeProjects/homage to the punk): quote math from
 * `web/lib/homage.ts` (the pure scaling lives in ../homage-quote-math.ts),
 * ownership checks from `web/lib/useHomageMint.ts`, proofs from
 * `web/lib/allowlist.ts`. The merkle artifact is vendored BYTE-IDENTICAL —
 * see the comment on the import below.
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

import { isAddress, parseAbi, zeroAddress, type Address, type PublicClient } from "viem"
import { homageAbi, permanenceRendererAbi } from "@pin/abi"
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
// ⚠️ SINGLE-SOURCED ARTIFACT — this JSON is a byte-identical copy of the
// Homage repo's `web/data/allowlist-proofs.json` (generated there by
// scripts/build-allowlist.mjs; root 0x32218882…). The Homage site is the
// canonical mint venue and both frontends must verify against the same
// onchain root: if the tree is ever regenerated, re-copy the new artifact
// here VERBATIM in the same change. Never hand-edit this file.
import allowlistProofs from "@/data/homage-allowlist-proofs.json"

// ── canonical mainnet addresses (mirrors the Homage repo's web/lib/homage.ts) ─

/** The $111 coin escrowed inside each homage (mainnet). */
export const TOKEN_111 = "0x61C9d89fe1212F6b55fF888816A151463287B8ae" as const
/** The live ETH/$111 v4 pool id Homage mints swap through (read for quoting). */
export const HOMAGE_POOL_ID =
  "0xf860d8f4896aed6cc1c68d234ba728680902f0ae43a459fbee6f6baa8036f795" as const
/** v4 periphery (canonical mainnet deployments). */
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

/** Canonical CryptoPunks contracts (mainnet) — the claim window's ownership
 *  sources, mirroring Homage._isPunkHolder: raw ownership is the market's
 *  `punkIndexToAddress`; a wrapped punk reports the wrapper as owner, so the
 *  true holder is the wrapper's `ownerOf`. */
export const CRYPTOPUNKS_MARKET = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB" as const
export const WRAPPED_PUNKS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6" as const

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
// lookup stays undefined client-side and silently drops the descriptor). Both
// must be present + valid for the venue to register; unsetting them is the
// launch rollback lever (the whole /mint/homage surface disappears cleanly).
const HOMAGE_ADDRESS = process.env.NEXT_PUBLIC_HOMAGE_ADDRESS
const HOMAGE_RENDERER = process.env.NEXT_PUBLIC_HOMAGE_RENDERER

/** Sample punk rendered as the collection hero (any id renders — the art is
 *  abstract either way; one of the Homage site's cycling hero samples). */
const HERO_SAMPLE_PUNK_ID = 3542n

// ── allowlist proofs (baked at build time) ────────────────────────────────────

type ProofFile = { root: `0x${string}`; count: number; proofs: Record<string, `0x${string}`[]> }
const proofFile = allowlistProofs as ProofFile

export const HOMAGE_ALLOWLIST_ROOT = proofFile.root

/** The Merkle proof for `address`, or null if it isn't on the allowlist. */
export function allowlistProofFor(address: string): `0x${string}`[] | null {
  return proofFile.proofs[address.toLowerCase()] ?? null
}

// ── quote provider: "homage-quote" ────────────────────────────────────────────
// One provider serves all three phases; the fee folded into msg.value differs:
// public pays the caller's escalating `mintFeeOf(wallet)`, claim + allowlist
// pay the flat `baseFee` (priority, not a discount — the swap/escrow economics
// are identical). Throwing (quoter revert, thin pool) disables the mint button
// with the reason, per the registry contract.

registerQuoteProvider("homage-quote", async ({ client, wallet, phaseKey }) => {
  if (!HOMAGE_ADDRESS || !isAddress(HOMAGE_ADDRESS)) throw new Error("Homage is not configured")
  const homage = HOMAGE_ADDRESS as Address
  const isPublic = phaseKey === "public" || phaseKey === null

  // Pool spot + the phase's ETH fee in one multicall.
  const [slot0Res, feeRes] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: V4_STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [HOMAGE_POOL_ID] },
      isPublic
        ? { address: homage, abi: homageAbi as Abi, functionName: "mintFeeOf", args: [wallet ?? zeroAddress] }
        : { address: homage, abi: homageAbi as Abi, functionName: "baseFee" },
    ],
  })
  if (slot0Res.status !== "success") throw new Error("pool price unavailable")
  if (feeRes.status !== "success") throw new Error("mint fee unavailable")
  const sqrtP = (slot0Res.result as readonly [bigint, number, number, number])[0]
  const fee = feeRes.result as bigint

  // Size the probe from spot, then run ONE real quote through the live pool
  // (LP fee + skim + price impact all reflected) and scale linearly to clear
  // THRESHOLD + 5%. Excess $111/ETH is refunded by the contract.
  const probe = (() => {
    const spot = spotEthForThreshold(sqrtP) // throws "pool not initialized" on 0
    return spot > 0n ? spot : 10n ** 15n
  })()
  const [probeOut] = (await client.readContract({
    address: V4_QUOTER,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: POOL_KEY, zeroForOne: true, exactAmount: probe, hookData: "0x" }],
  })) as readonly [bigint, bigint]
  const { ethForSwap } = scaleSwapForThreshold(probe, probeOut, DEFAULT_SAFETY_BPS)

  const value = ethForSwap + fee
  return {
    value,
    breakdown: [
      { label: "Buys 50,000 $111", wei: ethForSwap },
      { label: isPublic ? "Mint fee (this wallet)" : "Mint fee", wei: fee },
      { label: "Total", wei: value },
    ],
    note: "Includes 5% headroom; excess $111 and leftover ETH are refunded",
    ttlMs: 30_000,
  }
})

// ── claim phase: eligibility + args ("homage-claim") ─────────────────────────

/** One claimable punk offered by the picker. */
export type HomagePunkPick = { id: number; wrapped: boolean }

/** The claim eligibility payload handed to the HomagePunkPicker selector. */
export type HomageClaimData = { punks: HomagePunkPick[] }

registerEligibilityProvider("homage-claim", async ({ client, wallet }) => {
  if (!HOMAGE_ADDRESS || !isAddress(HOMAGE_ADDRESS)) throw new Error("Homage is not configured")
  if (!wallet) {
    return { eligible: false, reason: "Connect the wallet that holds your punk." }
  }
  const homage = HOMAGE_ADDRESS as Address

  // Wrapped punks: ERC721Enumerable, so balanceOf + tokenOfOwnerByIndex lists
  // them exactly — no log scan. (The market reports the wrapper as the raw
  // owner for these; claim() resolves the true holder through the wrapper.)
  const wBal = (await client.readContract({
    address: WRAPPED_PUNKS,
    abi: wrappedPunksAbi,
    functionName: "balanceOf",
    args: [wallet],
  })) as bigint
  let ids: bigint[] = []
  if (wBal > 0n) {
    const idxReads = await client.multicall({
      allowFailure: true,
      contracts: Array.from({ length: Number(wBal) }, (_, i) => ({
        address: WRAPPED_PUNKS,
        abi: wrappedPunksAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [wallet, BigInt(i)] as const,
      })),
    })
    ids = idxReads.filter((r) => r.status === "success").map((r) => r.result as bigint)
  }

  // Filter to punks whose homage is still unminted (tokenId == punkId).
  let punks: HomagePunkPick[] = []
  if (ids.length > 0) {
    const mintedReads = await client.multicall({
      allowFailure: true,
      contracts: ids.map((id) => ({
        address: homage,
        abi: homageAbi as Abi,
        functionName: "isMinted",
        args: [id] as const,
      })),
    })
    punks = ids
      .filter((_, i) => mintedReads[i]?.status === "success" && mintedReads[i].result === false)
      .map((id) => ({ id: Number(id), wrapped: true }))
      .sort((a, b) => a.id - b.id)
  }

  // Raw punks can't be enumerated cheaply (the 2017 market isn't ERC-721 and
  // we don't log-scan), so a wallet with no wrapped punks is still ELIGIBLE:
  // the picker's manual id input verifies raw ownership per id.
  const data: HomageClaimData = { punks }
  return {
    eligible: true,
    reason:
      punks.length > 0
        ? `You hold ${punks.length} punk${punks.length === 1 ? "" : "s"} with an unminted homage.`
        : "No wrapped punks with an unminted homage found in this wallet. Hold a raw punk? Enter its id below.",
    data,
  }
})

registerArgsBuilder("homage-claim", ({ selection }) => {
  const id = typeof selection === "number" && Number.isInteger(selection) ? selection : null
  if (id === null || id < 0 || id > 9999) throw new Error("Pick the punk to claim first")
  return [BigInt(id)]
})

/**
 * Verify `wallet` holds punk `id` (mirrors Homage._isPunkHolder) and that its
 * homage is unminted — the picker's manual-id path, fired ONLY on an explicit
 * user action (never per keystroke/render). 1 multicall + at most 1 read.
 */
export async function verifyPunkClaimable(
  client: PublicClient,
  id: number,
  wallet: Address,
): Promise<{ ok: boolean; reason?: string; wrapped?: boolean }> {
  if (!HOMAGE_ADDRESS || !isAddress(HOMAGE_ADDRESS)) return { ok: false, reason: "not configured" }
  const homage = HOMAGE_ADDRESS as Address
  const [ownerRes, mintedRes] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, functionName: "punkIndexToAddress", args: [BigInt(id)] },
      { address: homage, abi: homageAbi as Abi, functionName: "isMinted", args: [BigInt(id)] },
    ],
  })
  if (ownerRes.status !== "success" || mintedRes.status !== "success")
    return { ok: false, reason: "couldn't check ownership. Try again" }
  if (mintedRes.result === true) return { ok: false, reason: `#${id} has already been minted` }
  const rawOwner = ownerRes.result as Address
  if (rawOwner.toLowerCase() === wallet.toLowerCase()) return { ok: true, wrapped: false }
  if (rawOwner.toLowerCase() === WRAPPED_PUNKS.toLowerCase()) {
    // Wrapped: the true holder is the wrapper's ownerOf — one extra read.
    try {
      const holder = (await client.readContract({
        address: WRAPPED_PUNKS,
        abi: wrappedPunksAbi,
        functionName: "ownerOf",
        args: [BigInt(id)],
      })) as Address
      if (holder.toLowerCase() === wallet.toLowerCase()) return { ok: true, wrapped: true }
    } catch {
      return { ok: false, reason: "couldn't check the wrapper. Try again" }
    }
  }
  return { ok: false, reason: `this wallet doesn't hold #${id}` }
}

// ── allowlist phase: eligibility + args ("homage-allowlist") ─────────────────

type HomageAllowlistData = { proof: `0x${string}`[]; remaining: number; max: number }

registerEligibilityProvider("homage-allowlist", async ({ client, wallet }) => {
  if (!HOMAGE_ADDRESS || !isAddress(HOMAGE_ADDRESS)) throw new Error("Homage is not configured")
  if (!wallet) return { eligible: false, reason: "Connect a wallet to check the allowlist." }
  const proof = allowlistProofFor(wallet)
  if (!proof) return { eligible: false, reason: "This wallet is not on the allowlist." }
  const homage = HOMAGE_ADDRESS as Address

  // Remaining cap + a root sanity check, one multicall once per wallet+phase.
  const [rootRes, maxRes, usedRes] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: homage, abi: homageAbi as Abi, functionName: "allowlistRoot" },
      { address: homage, abi: homageAbi as Abi, functionName: "maxPerAllowlisted" },
      { address: homage, abi: homageAbi as Abi, functionName: "allowlistMinted", args: [wallet] },
    ],
  })
  // Guard against a rotated onchain root: baked proofs would revert with
  // NotAllowlisted, so fail the check with an honest reason instead.
  if (rootRes.status === "success" && (rootRes.result as string) !== HOMAGE_ALLOWLIST_ROOT) {
    return {
      eligible: false,
      reason: "The onchain allowlist root doesn't match this build's proofs. Mint on the Homage site.",
    }
  }
  const max = maxRes.status === "success" ? Number(maxRes.result as bigint) : 0
  const used = usedRes.status === "success" ? Number(usedRes.result as bigint) : 0
  const remaining = Math.max(max - used, 0)
  if (remaining <= 0) {
    return { eligible: false, reason: `Allowlist cap reached (${used} of ${max} used).` }
  }
  const data: HomageAllowlistData = { proof, remaining, max }
  return {
    eligible: true,
    reason: `On the allowlist. ${remaining} of ${max} mints left; a random punk is drawn at mint.`,
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
  if (!HOMAGE_ADDRESS || !isAddress(HOMAGE_ADDRESS)) return null
  if (!HOMAGE_RENDERER || !isAddress(HOMAGE_RENDERER)) return null
  return {
    slug: "homage",
    name: "Homage to the Punk",
    description:
      "Redeemable, $111-backed homages to the CryptoPunks: one per punk, art derived from its pixels. Your ETH is swapped onchain into 50,000 $111 and escrowed inside the piece; redeem any time to burn it and take the coins back out.",
    chainId,
    address: HOMAGE_ADDRESS as Address,
    abi: homageAbi as unknown as Abi,
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
    hero: {
      kind: "renderer-contract",
      address: HOMAGE_RENDERER as Address,
      abi: permanenceRendererAbi as unknown as Abi,
      fn: "tokenURI",
      tokenId: HERO_SAMPLE_PUNK_ID,
    },
    // The hero is a sample punk's render, so its tokenURI name ("Permanence
    // #3542") must NOT retitle the collection page — keep the descriptor's
    // identity (page.tsx honors this flag).
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
