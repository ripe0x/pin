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
import { foundry, mainnet } from "wagmi/chains"
import {
  RENDER_ASSETS,
  SURFACE_FACTORY,
  getAddressOrNull,
} from "@pin/addresses"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/** Fixed referral share, in bps. Must match FixedPriceMinter.REFERRAL_SHARE_BPS
 *  (moved off the token in the thin-token rearchitecture — the canonical
 *  minter pays it, not the collection). */
export const REFERRAL_SHARE_BPS = 1000 // 10%

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Must match wagmi.ts `forkChain` (31339) so wallet/link/chain checks agree.
const FORK_CHAIN_ID = 31339
export const PND_CHAIN = FORK_MODE ? foundry : mainnet
export const PND_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : mainnet.id

/** The CollectionFactory address (env override for local dev wins). */
export function surfaceFactory(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_SURFACE_FACTORY
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(SURFACE_FACTORY, chainId)
}

/** The RenderAssets registry address (env override for local dev wins). */
export function renderAssetsAddress(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_RENDER_ASSETS
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(RENDER_ASSETS, chainId)
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
  name: string
  symbol: string
  owner: Address
  /** The renderer pointer is permanently pinned (optional, off by default). */
  isRendererLocked: boolean
  isSupplyLocked: boolean
  renderer: Address
  cfg: SurfaceConfig
  /** Frontend-discovery default: mirrors the collection's own
   *  primaryMinter(), from the indexed row (seeded from SurfaceCreated,
   *  kept current by PrimaryMinterSet) — null when none is on record
   *  (not indexed, or a bring-your-own/pooled collection with no primary
   *  set). Not proof that no other authorized minter exists; only that no
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

/** evm.now address URL, chain-aware (per the project's tx-link rule). */
export function evmNowAddressUrl(addr: string, chainId: number = PND_CHAIN_ID): string {
  return `https://evm.now/address/${addr}?chainId=${chainId}`
}

/** evm.now tx URL, chain-aware (per the project's tx-link rule). */
export function evmNowTxUrl(hash: string, chainId: number = PND_CHAIN_ID): string {
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
