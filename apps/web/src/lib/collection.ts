/**
 * Surface — shared, client-safe helpers.
 *
 * One OZ ERC721 contract == one collection (edition, generative collection,
 * or backed/pooled work depending on which modules fill its slots).
 * Constants, enums/labels, ABI-return decoders, and lifecycle/pricing helpers
 * used by both server reads (lib/collection-onchain.ts) and client
 * components. No server-only imports.
 *
 * Mirrors the structure of lib/pnd-editions.ts; see SurfaceTypes.sol +
 * interfaces/ISurface.sol for the source-of-truth shapes.
 */
import { type Address, formatEther, isAddress } from "viem"
import { foundry, mainnet, sepolia } from "wagmi/chains"
import {
  DEFAULT_RENDERER,
  RENDER_ASSETS,
  SURFACE_FACTORY,
  SURFACE_FACTORY_V2,
  getAddressOrNull,
} from "@pin/addresses"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/** Referral-share cap and default, in bps. Must match
 *  FixedPriceMinter.MAX_REFERRAL_SHARE_BPS; the live per-minter value is
 *  referralShareBps() (owner/admin settable up to this cap) and is read into
 *  MinterSaleConfig. Used as the fallback where no live read is available. */
export const REFERRAL_SHARE_BPS = 1000 // 10%

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Must match wagmi.ts `forkChain` so wallet/link/chain checks agree; honors the
// same NEXT_PUBLIC_FORK_CHAIN_ID override (default 31339, e.g. set 31337 to
// target an anvil forked at Hardhat's id).
const FORK_CHAIN_ID = Number(process.env.NEXT_PUBLIC_FORK_CHAIN_ID || "31339")
// Opt-in sepolia instance for running the Homage mint surface against a live
// testnet deployment. Mutually exclusive with FORK_MODE; a no-op when unset,
// so mainnet production stays byte-identical.
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"
export const PND_CHAIN = FORK_MODE ? foundry : USE_SEPOLIA ? sepolia : mainnet
export const PND_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : USE_SEPOLIA ? sepolia.id : mainnet.id

/** The CollectionFactory address (env override for local dev wins). */
export function surfaceFactory(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_SURFACE_FACTORY
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(SURFACE_FACTORY, chainId)
}

/** The SurfaceFactoryV2 address (env override for local dev wins). */
export function surfaceFactoryV2(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_SURFACE_FACTORY_V2
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(SURFACE_FACTORY_V2, chainId)
}

/** The RenderAssets registry address (env override for local dev wins). */
export function renderAssetsAddress(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_RENDER_ASSETS
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(RENDER_ASSETS, chainId)
}

/** The DefaultRenderer address (env override for local dev wins). */
export function defaultRendererAddress(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_DEFAULT_RENDERER
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(DEFAULT_RENDERER, chainId)
}

/**
 * The referrer address PND passes when a mint happens on this app — it
 * receives the fixed referral share. A self-hosted page passes the artist's
 * own address instead (so the artist keeps it). Defaults to zero (PND
 * collects nothing) until a treasury is configured.
 */
export function pndReferrerAddress(): Address {
  // NEXT_PUBLIC_* must be literal reads (dynamic lookups are stripped from the
  // client bundle). The legacy *_SURFACE_* name is read as a fallback so the
  // rename can roll through env config without a coordinated deploy.
  const env =
    process.env.NEXT_PUBLIC_PND_REFERRAL_ADDRESS || process.env.NEXT_PUBLIC_PND_SURFACE_ADDRESS
  if (env && isAddress(env)) return env as Address
  return ZERO_ADDRESS
}

// ── enums (mirror SurfaceTypes.sol) ──────────────────────────────────────────

export enum SurfaceStatus {
  Scheduled = 0,
  Open = 1,
  Closed = 2,
}

export enum IdMode {
  Sequential = 0,
  Pooled = 1,
}

export enum CodeKind {
  Script = 0,
  ScriptGzip = 1,
}

export const COLLECTION_STATUS_LABEL: Record<number, string> = {
  [SurfaceStatus.Scheduled]: "Scheduled",
  [SurfaceStatus.Open]: "Open",
  [SurfaceStatus.Closed]: "Closed",
}

export const ID_MODE_LABEL: Record<number, string> = {
  [IdMode.Sequential]: "Sequential",
  [IdMode.Pooled]: "Pooled",
}

export const CODE_KIND_LABEL: Record<number, string> = {
  [CodeKind.Script]: "Script",
  [CodeKind.ScriptGzip]: "Script (gzip)",
}

// ── types (mirror SurfaceTypes.sol structs) ──────────────────────────────────

export type CodeRef = {
  store: Address
  name: string
  kind: CodeKind
}

export type WorkConfig = {
  code: CodeRef[]
  deps: CodeRef[]
  codeURI: string
  codeHash: `0x${string}`
  injectionVersion: number
  renderParams: string
}

/** Mirrors the token's shrunk SurfaceConfig (thin-token rearchitecture): sale
 *  economics (price, window, payout, priceStrategy) and the mint-hook slot
 *  moved off the token entirely, onto the canonical minter — see
 *  MinterSaleConfig. idMode stays separate (read via idMode(), not part of
 *  the struct). */
export type SurfaceConfig = {
  supplyCap: bigint
  royaltyBps: number
  royaltyReceiver: Address
  renderer: Address
  idMode: IdMode
}

/** A canonical FixedPriceMinter clone's live sale config — everything that
 *  used to live on the token's SurfaceConfig (price, window, payout,
 *  priceStrategy) plus the gating fields that used to live on a GateHook
 *  (allowlistRoot, walletCap; the mint-hook slot is gone, these are just
 *  minter config now). `null` on a Collection means no canonical minter is
 *  wired (bring-your-own minter, or a pooled collection — createPooledSurface
 *  never sets one): the mint page shows a quiet notice instead of a buy flow
 *  in that case, per sellsViaMinterOnly. */
export type MinterSaleConfig = {
  price: bigint
  priceStrategy: Address
  mintStart: bigint
  mintEnd: bigint
  payout: Address
  maxMints: bigint
  allowlistRoot: `0x${string}`
  walletCap: bigint
  referralShareBps: number
}

/** The window/cap inputs lifecycleStatus/isMintable derive a status from.
 *  mintStart/mintEnd now come from the minter's sale config (or zero when
 *  there is none); supplyCap is still a token-level (structural) fact. */
export type SaleWindow = {
  mintStart: bigint
  mintEnd: bigint
  supplyCap: bigint
}

export type Collection = {
  address: Address
  /** SurfaceCore.version()/SurfaceV2.version(): 1 for a v1 Surface, 2 for a
   *  v2 Surface. Read live off the collection itself (a bytecode constant,
   *  free of the indexer), never inferred from which factory deployed it.
   *  Selects which factory/ABI a write flow (mint gate, sale settings)
   *  targets for this collection. */
  protocolVersion: number
  name: string
  symbol: string
  owner: Address
  /** The renderer pointer is permanently pinned (optional, off by default). */
  isRendererLocked: boolean
  isSupplyLocked: boolean
  renderer: Address
  cfg: SurfaceConfig
  /** Freezes the authorized-minter set (see SurfaceCore/SurfaceV2.lockMinter).
   *  Present on both versions. */
  isMinterLocked: boolean
  /** v2 only (see SurfaceV2.lockRoyalty); always false for v1, which has no
   *  royalty lock. */
  isRoyaltyLocked: boolean
  /** Sealed is reported by SurfaceV2.permanence (the owner renounced
   *  ownership, engaging every remaining lock and permanently ending
   *  minting if no minter was granted); v1 collections report false. */
  sealed: boolean
  /** Frontend-discovery default: mirrors the collection's own
   *  primaryMinter(), from the indexed row (seeded from SurfaceCreated,
   *  kept current by PrimaryMinterSet). Null when none is on record
   *  (not indexed, or a bring-your-own/pooled collection with no primary
   *  set). Not proof that no other authorized minter exists, only that no
   *  primary is on record. There is no live-chain way to recover this
   *  cheaply beyond the single primaryMinter() read: the token has no
   *  "list of minters" getter, only isMinter(candidate). */
  primaryMinter: Address | null
  /** The primary minter's live sale config, read directly off
   *  `primaryMinter` when present. Null exactly when `primaryMinter` is
   *  null, or when it's set but doesn't implement this sale shape (a
   *  bring-your-own minter). */
  sale: MinterSaleConfig | null
  /** What the work is, executably — read from the GenerativeRenderer's
   *  work registry (renderer-land), empty for renderer-native works or
   *  custom renderers. */
  work: WorkConfig
  /** Cover image from the RenderAssets registry ("" when unset). */
  cover: string
  minted: bigint
}

/** The sale window a collection currently offers, folding in the "no
 *  canonical minter" case as an always-open, no-window / no-cap-beyond-token
 *  default (mintStart/mintEnd 0). supplyCap is always the token's own. */
export function saleWindowOf(c: Pick<Collection, "cfg" | "sale">): SaleWindow {
  return {
    mintStart: c.sale?.mintStart ?? 0n,
    mintEnd: c.sale?.mintEnd ?? 0n,
    supplyCap: c.cfg.supplyCap,
  }
}

// ── ABI-return decoders ──────────────────────────────────────────────────────

type RawCodeRef = {
  store: Address
  name: string
  kind: number
}

function decodeCodeRef(raw: RawCodeRef): CodeRef {
  return { store: raw.store, name: raw.name, kind: Number(raw.kind) }
}

type RawWorkConfig = {
  code: readonly RawCodeRef[]
  deps: readonly RawCodeRef[]
  codeURI: string
  codeHash: `0x${string}`
  injectionVersion: number
  renderParams: string
}

export function decodeWorkConfig(raw: RawWorkConfig): WorkConfig {
  return {
    code: raw.code.map(decodeCodeRef),
    deps: raw.deps.map(decodeCodeRef),
    codeURI: raw.codeURI,
    codeHash: raw.codeHash,
    injectionVersion: Number(raw.injectionVersion),
    renderParams: raw.renderParams,
  }
}

// Mirrors the onchain SurfaceConfig struct returned by config() (thin-token
// rearchitecture: price/window/payout/mintHook/priceStrategy moved off the
// token onto the canonical minter, see MinterSaleConfig). idMode is NOT a
// field here — it's a structural fact read separately via idMode(). The two
// one-way locks live on the struct but are surfaced separately on the
// collection (isRendererLocked/isSupplyLocked), so this decoder ignores them.
type RawSurfaceConfig = {
  supplyCap: bigint
  royaltyBps: number
  royaltyReceiver: Address
  renderer: Address
  rendererLocked: boolean
  supplyLocked: boolean
}

/** idMode is read separately (idMode()); it left the config struct in the
 *  Sequential/Pooled split, so it's passed in rather than decoded from raw. */
export function decodeCollectionConfig(raw: RawSurfaceConfig, idMode: IdMode): SurfaceConfig {
  return {
    supplyCap: raw.supplyCap,
    royaltyBps: Number(raw.royaltyBps),
    royaltyReceiver: raw.royaltyReceiver,
    renderer: raw.renderer,
    idMode,
  }
}

/** One multicall result entry (viem's allowFailure:true shape), loose
 *  enough to accept without importing viem's own multicall types here. */
export type MulticallEntry<T> = { status: "success"; result: T } | { status: "failure"; error?: unknown }

/** SurfaceV2.permanence() tuple: rendererLocked, supplyLocked, minterLocked,
 *  royaltyLocked, sealed, version. minterLocked and version aren't
 *  surfaced on Collection today; the tuple is still decoded positionally
 *  in full so the shape stays checked against the real ABI. */
export type PermanenceTuple = readonly [boolean, boolean, boolean, boolean, boolean, bigint]

export type Locks = {
  isRendererLocked: boolean
  isSupplyLocked: boolean
  isMinterLocked: boolean
  isRoyaltyLocked: boolean
  sealed: boolean
}

/**
 * The lock/seal facts for a collection. For a v2 row with a successful
 * permanence() call, every flag (renderer, supply, minter, royalty, sealed)
 * comes from that single tuple, the source of truth for v2. Otherwise (v1,
 * or a v2 row whose permanence() call itself failed) falls back to the
 * individual isRendererLocked/isSupplyLocked/isMinterLocked reads, with
 * isRoyaltyLocked and sealed false: v1 has no royalty lock and no seal.
 */
export function decodeLocks(
  protocolVersion: number,
  individual: { isRendererLocked: boolean; isSupplyLocked: boolean; isMinterLocked: boolean },
  permanence: MulticallEntry<PermanenceTuple> | undefined,
): Locks {
  if (protocolVersion === 2 && permanence?.status === "success") {
    const [rendererLocked, supplyLocked, minterLocked, royaltyLocked, sealed] = permanence.result
    return {
      isRendererLocked: rendererLocked,
      isSupplyLocked: supplyLocked,
      isMinterLocked: minterLocked,
      isRoyaltyLocked: royaltyLocked,
      sealed,
    }
  }
  return {
    isRendererLocked: individual.isRendererLocked,
    isSupplyLocked: individual.isSupplyLocked,
    isMinterLocked: individual.isMinterLocked,
    isRoyaltyLocked: false,
    sealed: false,
  }
}

/** The studio Collection Settings tool's /settings API response shape. */
export type CollectionSettings = {
  name: string
  owner: Address
  protocolVersion: number
  renderer: Address
  isRendererLocked: boolean
  isSupplyLocked: boolean
  isMinterLocked: boolean
  isRoyaltyLocked: boolean
  sealed: boolean
  supplyCap: string
  minted: string
  royaltyBps: number
  royaltyReceiver: Address
  cover: string
  renderAssets: Address | null
  creators: { creator: Address; confirmed: boolean }[]
}

/**
 * Builds the /settings API response from an already-read Collection, a
 * separately-fetched creator roster, and the network's RenderAssets
 * address. A pure formatter (no chain/DB reads of its own) so the API
 * route's response shape is unit-testable against a fabricated Collection.
 */
export function buildCollectionSettings(
  c: Pick<
    Collection,
    | "name"
    | "owner"
    | "protocolVersion"
    | "renderer"
    | "isRendererLocked"
    | "isSupplyLocked"
    | "isMinterLocked"
    | "isRoyaltyLocked"
    | "sealed"
    | "cfg"
    | "cover"
    | "minted"
  >,
  creators: { creator: Address; confirmed: boolean }[],
  renderAssets: Address | null,
): CollectionSettings {
  return {
    name: c.name,
    owner: c.owner,
    protocolVersion: c.protocolVersion,
    renderer: c.renderer,
    isRendererLocked: c.isRendererLocked,
    isSupplyLocked: c.isSupplyLocked,
    isMinterLocked: c.isMinterLocked,
    isRoyaltyLocked: c.isRoyaltyLocked,
    sealed: c.sealed,
    supplyCap: c.cfg.supplyCap.toString(),
    minted: c.minted.toString(),
    royaltyBps: c.cfg.royaltyBps,
    royaltyReceiver: c.cfg.royaltyReceiver,
    cover: c.cover,
    renderAssets,
    creators,
  }
}

// ── lifecycle + pricing helpers ──────────────────────────────────────────────

export function isGasOnly(price: bigint): boolean {
  return price === 0n
}

/** True when a price strategy contract is set (overrides the stored price). */
export function hasPriceStrategy(priceStrategy: Address): boolean {
  return priceStrategy.toLowerCase() !== ZERO_ADDRESS
}

/**
 * Formats a minter's stored fixed price. Only meaningful when
 * `!hasPriceStrategy(sale.priceStrategy)` — when a strategy is set, prices
 * must come from a live `priceOf` read on the minter (see getCurrentPrice in
 * collection-onchain.ts), not this stored field. Currency label is always
 * "ETH".
 */
export function formatPriceLabel(price: bigint): string {
  return isGasOnly(price) ? "Gas only" : `${trimEth(formatEther(price))} ETH`
}

/**
 * Formats a live-read price (e.g. from priceOf). Same rendering as
 * formatPriceLabel; kept as a distinct name so call sites are explicit about
 * whether the value came from stored config or a live strategy read.
 */
export function formatLivePriceLabel(price: bigint): string {
  return formatPriceLabel(price)
}

function trimEth(s: string): string {
  if (!s.includes(".")) return s
  return s.replace(/\.?0+$/, "")
}

export function formatBps(bps: number): string {
  const pct = bps / 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`
}

/** Derived sale-phase status (Scheduled/Open/Closed): the token no longer
 * carries this (7.6 of the thin-token rearchitecture removed SurfaceStatus
 * from the token entirely), so it's computed client/lib-side from the
 * minter's window (mintStart/mintEnd, via saleWindowOf) plus the token's own
 * cap state — never from stored state. */
export function lifecycleStatus(cfg: SaleWindow, minted: bigint, nowSec: number): SurfaceStatus {
  if (cfg.mintStart !== 0n && BigInt(nowSec) < cfg.mintStart) return SurfaceStatus.Scheduled
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return SurfaceStatus.Closed
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return SurfaceStatus.Closed
  return SurfaceStatus.Open
}

export function isMintable(cfg: SaleWindow, minted: bigint, nowSec: number): boolean {
  if (cfg.mintStart !== 0n && BigInt(nowSec) < cfg.mintStart) return false
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return false
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return false
  return true
}

/** True when the collection sells exclusively through an authorized minter
 * extension with no direct buy flow on this page (pooled collections never
 * wire a canonical minter — createPooledSurface has no canonical-minter
 * form, per docs/pnd-surface-thin-token-rearchitecture.md §3.5). Sequential
 * collections with no primary minter on record (bring-your-own, or not yet
 * indexed) hit the same notice — see the `primaryMinter === null` check at
 * call sites, which this idMode-only helper doesn't see. */
export function sellsViaMinterOnly(idMode: IdMode): boolean {
  return idMode === IdMode.Pooled
}

/** Canonical pnd: URN for a node, e.g. pnd:1:0xabc…:c (collection) or :t47 (token). */
export function pndUrn(
  chainId: number,
  contract: Address,
  kind: "c" | "t" | "x",
  id: bigint | number,
): string {
  return `pnd:${chainId}:${contract.toLowerCase()}:${kind}${kind === "c" ? "" : id.toString()}`
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Explorer address URL, chain-aware. Mainnet uses evm.now (the project's
 * multi-chain explorer); testnets use the network's own etherscan subdomain
 * — evm.now has no sepolia support.
 */
export function evmNowAddressUrl(addr: string, chainId: number = PND_CHAIN_ID): string {
  if (chainId === sepolia.id) return `https://sepolia.etherscan.io/address/${addr}`
  return `https://evm.now/address/${addr}?chainId=${chainId}`
}

/**
 * OpenSea collection URL for a contract, chain-aware. The bare
 * assets/<chain>/<address> path resolves to the collection page. Testnets use
 * testnets.opensea.io.
 */
export function openSeaAddressUrl(addr: string, chainId: number = PND_CHAIN_ID): string {
  if (chainId === sepolia.id) return `https://testnets.opensea.io/assets/sepolia/${addr}`
  return `https://opensea.io/assets/ethereum/${addr}`
}

/**
 * Explorer tx URL, chain-aware. Mainnet uses evm.now; testnets use the
 * network's own etherscan subdomain.
 */
export function evmNowTxUrl(hash: string, chainId: number = PND_CHAIN_ID): string {
  if (chainId === sepolia.id) return `https://sepolia.etherscan.io/tx/${hash}`
  return `https://evm.now/tx/${hash}?chainId=${chainId}`
}

/** Resolve an artwork URI to an https URL for OG/SSR (ipfs:// → gateway). */
export function ipfsToHttp(uri: string): string {
  if (!uri) return uri
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length).replace(/^ipfs\//, "")}`
  }
  return uri
}
