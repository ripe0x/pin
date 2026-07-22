// Homage to the Punk — the mint engine's contract surface, ported into PND.
//
// Homage is a POOLED Surface collection whose mints run through a bespoke
// `HomageMinter` extension (the ETH→$111 swap + escrow, an escalating per-wallet
// fee, a three-phase schedule, punk-holder claim, allowlist, and redeem). PND's
// generic direct-sale path can't drive that, so this module is the canonical home
// for the homage-specific mint logic on the PND side.
//
// Ported from the homage repo's `web/lib/homage.ts`. The one structural change:
// the collection + minter addresses are NOT read from env here — PND discovers
// them per-collection (see `detect.ts`), so `homageFlows` is parameterized by the
// minter address instead of closing over a module-level constant.

import {parseAbi, type Address, type PublicClient} from "viem"

// Opt-in sepolia instance (mirrors lib/collection.ts' PND_CHAIN_ID split):
// swaps the addresses below for the live sepolia deployment's stand-in
// contracts. A no-op when unset — mainnet addresses are unchanged.
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"

// ─── Live $111 coin + the v4 pool the mint swaps through (mainnet; present on the fork) ──
/** Sepolia: Mock111, an open-mint faucet token standing in for the real $111. */
export const TOKEN_111: Address = USE_SEPOLIA
  ? "0x27b862985ddcf75c5dba649549a26657332124c4"
  : "0x61C9d89fe1212F6b55fF888816A151463287B8ae"
export const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90" as const
export const SKIM_HOOK = "0x636c050296B5Cc528D8785169Bf8923716FCa9cc" as const
export const POOL_ID = "0xf860d8f4896aed6cc1c68d234ba728680902f0ae43a459fbee6f6baa8036f795" as const
export const STATE_VIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227" as const
export const V4_QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" as const
const DYN_FEE = 0x800000 // dynamic-fee flag (matches DeployDevSovereign)
const TICK_SPACING = 200

// ETH (currency0) → $111 (currency1), dynamic fee, skim hook — hashes to POOL_ID.
// Mainnet only; sepolia quotes go through MOCK_POOL_MANAGER instead.
export const POOL_KEY = {
  currency0: "0x0000000000000000000000000000000000000000",
  currency1: TOKEN_111,
  fee: DYN_FEE,
  tickSpacing: TICK_SPACING,
  hooks: SKIM_HOOK,
} as const

// Sepolia stand-in for the v4 pool: a hookless mock that mints TOKEN_111 to
// the caller for a flat ETH cost per swap (`weiPerSwap()`), no StateView/
// Quoter, no price curve — see `quoteMint`'s sepolia branch below.
export const MOCK_POOL_MANAGER = "0xf99a9c7d61047cd8b6d34e88c803d25a4162b41b" as const
export const mockPoolManagerAbi = parseAbi(["function weiPerSwap() view returns (uint256)"])

// CryptoPunks contracts — the ownership source for the holder-priority claim
// window. Raw ownership is `punkIndexToAddress`; a wrapped punk reports the
// wrapper as owner, so the true holder is the wrapper's `ownerOf` (mirrors
// HomageMinter._isPunkHolder). Sepolia: MockPunksMarket stands in for the
// market (settable punkIndexToAddress); neither WrappedPunks contract has a
// sepolia deployment, so wrapped-punks reads are skipped there (see
// HAS_WRAPPED_PUNKS below).
export const CRYPTOPUNKS_MARKET: Address = USE_SEPOLIA
  ? "0x1034699aa91c9e48765a1212ac1dccfac75a6882"
  : "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB"
export const WRAPPED_PUNKS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6" as const
// Official CryptoPunks 721 wrapper (tokenId == punkId); holders resolved like WRAPPED_PUNKS.
export const WRAPPED_PUNKS_721 = "0x000000000000003607fce1aC9e043a86675C5C2F" as const
/** Neither wrapped-punks contract is deployed on sepolia; every code path
 *  that would read one is gated on this instead of reading against an empty
 *  address. */
export const HAS_WRAPPED_PUNKS = !USE_SEPOLIA

// Delegate.xyz Registry v2 (canonical singleton, same address on mainnet and
// sepolia) — a cold vault delegates a hot wallet, which transacts the
// holder-priority claim via `claimFor` (mints to the vault).
export const DELEGATE_REGISTRY = "0x00000000000000447e69651d841bD8D104Bed493" as const

// Economic constants — mirror HomageMinter deploy defaults; every value is
// owner-tunable (setThreshold / setFeeSchedule / setExitFee) and MUST be
// read live before it drives a mint. A prior hardcoded THRESHOLD (50,000)
// drifted from the deployed default (30,000), sizing every quoted swap
// ~67% too large — quoteMint below reads threshold() live instead.
export const BASE_FEE = 4_200_000_000_000_000n // 0.0042 ETH — deploy default; real fee is mintFeeOf()
export const EXIT_FEE = 3_000_000_000_000_000n // 0.003 ETH — deploy default; read exitFee() live before redeem

// ─── ABIs ───────────────────────────────────────────────────────────────────────

// HomageMinter — the mint engine. Economics, schedule, allowlist, supply, and the
// mint/redeem writes. NOT the ERC721: ownership / tokenURI live on the collection.
export const homageMinterAbi = parseAbi([
  "function threshold() view returns (uint256)",
  "function exitFee() view returns (uint256)",
  "function SUPPLY() view returns (uint256)",
  "function remaining() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function isMinted(uint256 punkId) view returns (bool)",
  // per-wallet fee escalator (public mint)
  "function baseFee() view returns (uint256)",
  "function feeGrowthBps() view returns (uint256)",
  "function mintCount(address who) view returns (uint256)",
  "function mintFeeOf(address who) view returns (uint256)",
  // mint schedule (three windows)
  "function claimStart() view returns (uint64)",
  "function allowlistStart() view returns (uint64)",
  "function publicStart() view returns (uint64)",
  // Owner-only; used by the FORK-ONLY dev phase toggle (the connected dev wallet is
  // the owner on the local fork), so a phase switch moves the REAL schedule and the
  // whole page — masthead, chip, schedule, instrument, contract gating — follows.
  "function setSchedule(uint64 claimStart_, uint64 allowlistStart_, uint64 publicStart_)",
  // allowlist
  "function allowlistRoot() view returns (bytes32)",
  // punk-id reservation — a holder withholds their punk id from the random draw
  // pool until claim opens; unclaimed reservations release into the pool then.
  "function reserve(uint256[] ids) external",
  "function reserveMine(uint256[] ids) external",
  "function reserveVia(uint256[] ids, address vault) external",
  "function releaseReserved(uint256 max) external returns (uint256)",
  "function isReserved(uint256 id) view returns (bool)",
  "function reservedRemaining() view returns (uint256)",
  "function reservationOpen() view returns (bool)",
  // the collection this minter mints into — used by PND to confirm a collection's
  // authorized minter really is a HomageMinter (see detect.ts).
  "function collection() view returns (address)",
  // batch
  "function MAX_BATCH() view returns (uint256)",
  "function quoteBatchFee(address who, uint256 qty) view returns (uint256)",
  // mint paths
  "function mint() payable returns (uint256 punkId)",
  "function mintBatch(uint256 qty) payable returns (uint256[] ids)",
  "function claim(uint256 punkId) payable returns (uint256)",
  "function claimFor(uint256 punkId, address vault) payable returns (uint256)",
  "function claimTo(uint256 punkId) payable returns (uint256)",
  "function allowlistMint(bytes32[] proof) payable returns (uint256)",
  "function redeem(uint256 punkId) payable",
  "event Minted(address indexed to, uint256 indexed punkId, uint256 ethSwapped, uint256 received111)",
  "event Claimed(address indexed to, uint256 indexed punkId, uint256 ethSwapped, uint256 received111)",
  "event Redeemed(address indexed from, uint256 indexed punkId, uint256 amount111)",
  "event Reserved(uint256 indexed punkId, address indexed by)",
  "event ReservationReleased(uint256 indexed punkId)",
  "event Activated()",
  "event AllowlistRootSet(bytes32 root)",
  "event ExitFeeSet(uint256 exitFee)",
  "event FeeRecipientSet(address feeRecipient)",
  "event FeeScheduleSet(uint256 baseFee, uint256 feeGrowthBps)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event RedeemDelaySet(uint64 redeemDelay)",
  "event ScheduleSet(uint64 claimStart, uint64 allowlistStart, uint64 publicStart)",
  "event ThresholdSet(uint256 threshold)",
  // Every error HomageMinter.sol defines, so viem decodes a revert to its name
  // and arguments (e.g. RedeemLocked(opensAt)) instead of a bare selector.
  "error AllowlistClosed()",
  "error AlreadyActivated()",
  "error AlreadyMinted()",
  "error BadPunkId()",
  "error BadSchedule()",
  "error ClaimClosed()",
  "error CollectionAlreadyMinted()",
  "error CollectionNotPooled()",
  "error CostExceedsBudget(uint256 ethNeeded, uint256 ethBudget)",
  "error DrawPoolDesync()",
  "error ExitFeeOutOfBounds()",
  "error FeeScheduleOutOfBounds()",
  "error FeeTransferFailed()",
  "error InsufficientValue(uint256 required, uint256 provided)",
  "error InvalidBatchQuantity(uint256 qty, uint256 maxBatch)",
  "error InvalidThreshold()",
  "error MinterNotGranted()",
  "error MinterNotLocked()",
  "error NonexistentToken(uint256 id)",
  "error NotActivated()",
  "error NotAllowlisted()",
  "error NotBacked()",
  "error NotContract(address dependency)",
  "error NotDelegated()",
  "error NotManager()",
  "error NotPunkOwner()",
  "error NotTokenOwner()",
  "error NothingToCollect()",
  "error NothingToRescue()",
  "error OwnableInvalidOwner(address owner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error PublicClosed()",
  "error RedeemDelayOutOfBounds()",
  "error RedeemLocked(uint256 opensAt)",
  "error ReentrancyGuardReentrantCall()",
  "error RefundFailed()",
  "error ReleaseNotOpen()",
  "error RescueTransferFailed()",
  "error ReservationClosed()",
  "error SafeERC20FailedOperation(address token)",
  "error Slippage(uint256 received, uint256 needed)",
  "error SoldOut()",
  "error SupplyCapTooLow()",
  "error ThresholdLocked()",
  "error WrongExitFee(uint256 expected, uint256 provided)",
  "error WrongPoolCurrency()",
  "error ZeroAddress()",
  "error ZeroDependency()",
])

// Live-market status flag for the renderer: 255 = read the punk's real market state
// (wrapped / for-sale / has-bid) to pick the ground, rather than a fixed status.
export const STATUS_LIVE = 255

// HomageRendererSovereign — renders any punk id's homage (minted or not), so one path
// draws both the collection's minted tokens and the pre-mint sample field.
export const homageRendererViewAbi = parseAbi([
  // `circle` picks the form: false = classic squares, true = the PFP (inscribed
  // circles, same geometry/colors/order). lib/homage/art.ts mirrors the circle
  // form client-side as the zero-RPC fallback.
  "function renderSVG(uint256 id, uint8 status, bool circle) view returns (string)",
])

// The pooled Surface the minter mints into — token reads (ownership / tokenURI).
export const homageCollectionAbi = parseAbi([
  "function ownerOf(uint256 id) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenURI(uint256 id) view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
])

// CryptoPunks ownership reads for the claim window. The raw market isn't ERC-721:
// current ownership is `punkIndexToAddress`; acquisitions announce via
// Assign / PunkTransfer / PunkBought (recipient indexed, punk index in data).
export const punksMarketAbi = parseAbi([
  "function punkIndexToAddress(uint256 index) view returns (address)",
  "event Assign(address indexed to, uint256 punkIndex)",
  "event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex)",
  "event PunkBought(uint256 indexed punkIndex, uint256 value, address indexed fromAddress, address indexed toAddress)",
])

// WrappedPunks — canonical ERC-721Enumerable, so a holder's wrapped punks enumerate
// directly (balanceOf + tokenOfOwnerByIndex) with no log scan.
export const wrappedPunksAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
])

export const delegateRegistryAbi = parseAbi([
  "function checkDelegateForERC721(address to, address from, address contract_, uint256 tokenId, bytes32 rights) view returns (bool)",
  "struct Delegation { uint8 type_; address to; address from; bytes32 rights; address contract_; uint256 tokenId; uint256 amount; }",
  "function getIncomingDelegations(address to) view returns (Delegation[])",
])

// v4 StateView — pool spot (sqrtPriceX96) for sizing the quote probe.
export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
])

// v4 Quoter — simulate the real ETH→$111 swap (LP fee + 6% skim + price impact).
// Not a `view` in the ABI, but designed to be eth_call'd; readContract simulates fine.
export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
])

// ─── Mint flows (parameterized by the detected minter) ────────────────────────────
//
// One-click ETH mint: send `ethForSwap + fee` as `value`; the contract swaps
// `ethForSwap` into >= THRESHOLD $111, escrows exactly THRESHOLD inside a new random
// homage minted to you, refunds any excess, and reverts on slippage. Redeem burns it
// and returns the full THRESHOLD $111, paying the live `exitFee()`.

export function mintValue(ethForSwap: bigint, fee: bigint): bigint {
  return ethForSwap + fee
}

export function homageFlows(minter: Address) {
  return {
    mint: (value: bigint) =>
      ({address: minter, abi: homageMinterAbi, functionName: "mint", value}) as const,
    mintBatch: (qty: bigint, value: bigint) =>
      ({address: minter, abi: homageMinterAbi, functionName: "mintBatch", args: [qty], value}) as const,
    claim: (punkId: bigint, value: bigint) =>
      ({address: minter, abi: homageMinterAbi, functionName: "claim", args: [punkId], value}) as const,
    claimFor: (punkId: bigint, vault: Address, value: bigint) =>
      ({address: minter, abi: homageMinterAbi, functionName: "claimFor", args: [punkId, vault], value}) as const,
    // permissionless: any wallet pays, the punk's holder receives (CyberBrokers model)
    claimTo: (punkId: bigint, value: bigint) =>
      ({address: minter, abi: homageMinterAbi, functionName: "claimTo", args: [punkId], value}) as const,
    allowlistMint: (proof: readonly `0x${string}`[], value: bigint) =>
      ({address: minter, abi: homageMinterAbi, functionName: "allowlistMint", args: [proof], value}) as const,
    redeem: (punkId: bigint, value: bigint) =>
      ({address: minter, abi: homageMinterAbi, functionName: "redeem", args: [punkId], value}) as const,
    reserveMine: (ids: readonly bigint[]) =>
      ({address: minter, abi: homageMinterAbi, functionName: "reserveMine", args: [ids]}) as const,
    reserveVia: (ids: readonly bigint[], vault: Address) =>
      ({address: minter, abi: homageMinterAbi, functionName: "reserveVia", args: [ids, vault]}) as const,
  }
}

// ─── Quote the mint cost ──────────────────────────────────────────────────────────
//
// What ETH should `mint()` swap so it nets >= the minter's live escrow threshold
// ($111)? Read spot (StateView) to size a probe, run ONE real quote through the live
// pool (V4Quoter — reflects LP fee, 6% skim, price impact), then scale linearly to
// clear the threshold with a small safety margin. Exact-input, so any $111 over the
// threshold is refunded; erring high is safe. `threshold` is owner-tunable
// (`HomageMinter.setThreshold`) and is read live in every branch below, never
// hardcoded — a stale hardcoded 50,000 previously drifted from the deployed 30,000
// default, sizing every quoted swap ~67% too large.

const Q192 = 1n << 192n
const WAD = 10n ** 18n

export type MintQuote = {
  ethForSwap: bigint // ETH the mint will route into the pool
  totalValue: bigint // tx value = ethForSwap + the caller's current mint fee
  fee: bigint // the ETH fee folded in (mintFeeOf for public; baseFee for claim/allowlist)
  estReceived: bigint // ~$111 the swap nets (>= THRESHOLD)
  estRefund: bigint // ~$111 over THRESHOLD, refunded to the minter
  spotEthForThreshold: bigint // naive spot ETH for exactly THRESHOLD (no fee/skim/impact)
  price111PerEth: bigint // $111 (1e18) per 1 ETH, for display
  safetyBps: number
}

async function quoteExactInput(client: PublicClient, ethIn: bigint): Promise<bigint> {
  const res = (await client.readContract({
    address: V4_QUOTER,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{poolKey: POOL_KEY, zeroForOne: true, exactAmount: ethIn, hookData: "0x"}],
  })) as readonly [bigint, bigint]
  return res[0]
}

/**
 * Quote the mint. `minter` is read for the live `threshold()` (owner-tunable,
 * must not be hardcoded). `fee` is the ETH fee to fold into the tx value (the
 * caller's `mintFeeOf()` for a public mint, or `baseFee()` for a claim /
 * allowlist mint). `safetyBps` is headroom over the threshold (default 5%) to
 * absorb price drift.
 */
export async function quoteMint(
  client: PublicClient,
  minter: Address,
  fee: bigint,
  safetyBps = 500,
): Promise<MintQuote> {
  const threshold = (await client.readContract({
    address: minter,
    abi: homageMinterAbi,
    functionName: "threshold",
  })) as bigint

  // Sepolia: MOCK_POOL_MANAGER has no StateView/Quoter — it mints TOKEN_111 to
  // the caller for a flat ETH cost per swap (`weiPerSwap`, read live rather
  // than hardcoded). No headroom/refund math applies to a flat price.
  if (USE_SEPOLIA) {
    const ethForSwap = (await client.readContract({
      address: MOCK_POOL_MANAGER,
      abi: mockPoolManagerAbi,
      functionName: "weiPerSwap",
    })) as bigint
    return {
      ethForSwap,
      totalValue: ethForSwap + fee,
      fee,
      estReceived: threshold,
      estRefund: 0n,
      spotEthForThreshold: ethForSwap,
      price111PerEth: 0n,
      safetyBps: 0,
    }
  }
  const slot0 = (await client.readContract({
    address: STATE_VIEW,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [POOL_ID],
  })) as readonly [bigint, number, number, number]
  const sqrtP = slot0[0]
  if (sqrtP === 0n) throw new Error("pool not initialized")

  const price111PerEth = (sqrtP * sqrtP * WAD) / Q192
  const spotEthForThreshold = (threshold * Q192) / (sqrtP * sqrtP)
  const probe = spotEthForThreshold > 0n ? spotEthForThreshold : WAD / 1000n

  const out = await quoteExactInput(client, probe)
  if (out === 0n) throw new Error("quote returned zero")

  const target = (threshold * BigInt(10000 + safetyBps)) / 10000n
  const ethForSwap = (probe * target) / out + 1n
  const estReceived = (out * ethForSwap) / probe
  const estRefund = estReceived > threshold ? estReceived - threshold : 0n

  return {
    ethForSwap,
    totalValue: ethForSwap + fee,
    fee,
    estReceived,
    estRefund,
    spotEthForThreshold,
    price111PerEth,
    safetyBps,
  }
}
