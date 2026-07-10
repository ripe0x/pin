/**
 * Sovereign Collection — shared, client-safe helpers.
 *
 * One OZ ERC721 contract == one collection (edition, generative collection,
 * or backed/pooled work depending on which modules fill its slots).
 * Constants, enums/labels, ABI-return decoders, and lifecycle/pricing helpers
 * used by both server reads (lib/collection-onchain.ts) and client
 * components. No server-only imports.
 *
 * Mirrors the structure of lib/pnd-editions.ts; see CollectionTypes.sol +
 * interfaces/ISovereignCollection.sol for the source-of-truth shapes.
 */
import { type Address, formatEther, isAddress } from "viem"
import { foundry, mainnet } from "wagmi/chains"
import {
  ATTRIBUTION,
  GATE_HOOK,
  GENERATIVE_RENDERER,
  RENDER_ASSETS,
  SOVEREIGN_COLLECTION_FACTORY,
  getAddressOrNull,
} from "@pin/addresses"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/** Fixed protocol referral share, in bps. Must match Collection.REFERRAL_SHARE_BPS. */
export const REFERRAL_SHARE_BPS = 1000 // 10%

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Must match wagmi.ts `forkChain` (31339) so wallet/link/chain checks agree.
const FORK_CHAIN_ID = 31339
export const PND_CHAIN = FORK_MODE ? foundry : mainnet
export const PND_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : mainnet.id

/** The CollectionFactory address (env override for local dev wins). */
export function collectionFactory(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_SOVEREIGN_COLLECTION_FACTORY
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(SOVEREIGN_COLLECTION_FACTORY, chainId)
}

/** The RenderAssets registry address (env override for local dev wins). */
export function renderAssetsAddress(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_RENDER_ASSETS
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(RENDER_ASSETS, chainId)
}

/** The Attribution singleton address (env override for local dev wins). */
export function attributionAddress(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_ATTRIBUTION
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(ATTRIBUTION, chainId)
}

/** The canonical GateHook address (env override for local dev wins). A
 *  collection whose mintHook equals this gets the full eligibility UI;
 *  any other nonzero hook gets the generic gated-mint notice. */
export function gateHookAddress(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_GATE_HOOK
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(GATE_HOOK, chainId)
}

/**
 * The GenerativeRenderer singleton address (env override for local dev
 * wins). A SovereignCollectionFactory's baked-in `defaultRenderer` is
 * DefaultRenderer (static/SVG works) — the create wizard's GENERATIVE
 * preset must pass this address explicitly as `cfg.renderer` rather than
 * relying on the zero-address default. See
 * contracts/script/DeployCollectionSystem.s.sol deploy order.
 */
export function generativeRenderer(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_GENERATIVE_RENDERER
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(GENERATIVE_RENDERER, chainId)
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

// ── enums (mirror CollectionTypes.sol) ──────────────────────────────────────

export enum CollectionStatus {
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
  [CollectionStatus.Scheduled]: "Scheduled",
  [CollectionStatus.Open]: "Open",
  [CollectionStatus.Closed]: "Closed",
}

export const ID_MODE_LABEL: Record<number, string> = {
  [IdMode.Sequential]: "Sequential",
  [IdMode.Pooled]: "Pooled",
}

export const CODE_KIND_LABEL: Record<number, string> = {
  [CodeKind.Script]: "Script",
  [CodeKind.ScriptGzip]: "Script (gzip)",
}

// ── types (mirror CollectionTypes.sol structs) ──────────────────────────────

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

export type CollectionConfig = {
  price: bigint
  supplyCap: bigint
  mintStart: bigint
  mintEnd: bigint
  royaltyBps: number
  royaltyReceiver: Address
  payoutAddress: Address
  renderer: Address
  mintHook: Address
  priceStrategy: Address
  idMode: IdMode
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
  priceStrategy: Address
  cfg: CollectionConfig
  /** What the work is, executably — read from the GenerativeRenderer's
   *  work registry (renderer-land), empty for renderer-native works or
   *  custom renderers. */
  work: WorkConfig
  /** Cover image from the RenderAssets registry ("" when unset). */
  cover: string
  status: CollectionStatus
  minted: bigint
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

type RawCollectionConfig = {
  price: bigint
  supplyCap: bigint
  mintStart: bigint
  mintEnd: bigint
  royaltyBps: number
  royaltyReceiver: Address
  payoutAddress: Address
  renderer: Address
  mintHook: Address
  priceStrategy: Address
  idMode: number
}

export function decodeCollectionConfig(raw: RawCollectionConfig): CollectionConfig {
  return {
    price: raw.price,
    supplyCap: raw.supplyCap,
    mintStart: raw.mintStart,
    mintEnd: raw.mintEnd,
    royaltyBps: Number(raw.royaltyBps),
    royaltyReceiver: raw.royaltyReceiver,
    payoutAddress: raw.payoutAddress,
    renderer: raw.renderer,
    mintHook: raw.mintHook,
    priceStrategy: raw.priceStrategy,
    idMode: Number(raw.idMode),
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
 * Formats a collection's stored fixed price. Only meaningful when
 * `!hasPriceStrategy(cfg.priceStrategy)` — when a strategy is set, prices
 * must come from a live `currentPrice` read (see getCurrentPrice in
 * collection-onchain.ts), not this stored field. Currency label is always
 * "ETH".
 */
export function formatPriceLabel(price: bigint): string {
  return isGasOnly(price) ? "Gas only" : `${trimEth(formatEther(price))} ETH`
}

/**
 * Formats a live-read price (e.g. from currentPrice). Same rendering as
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

/** Mirror of Collection._lifecycleStatus(): derived purely from the window,
 * the cap, and the clock — never from stored state. */
export function lifecycleStatus(
  cfg: Pick<CollectionConfig, "mintStart" | "mintEnd" | "supplyCap">,
  minted: bigint,
  nowSec: number,
): CollectionStatus {
  if (cfg.mintStart !== 0n && BigInt(nowSec) < cfg.mintStart) return CollectionStatus.Scheduled
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return CollectionStatus.Closed
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return CollectionStatus.Closed
  return CollectionStatus.Open
}

export function isMintable(
  cfg: Pick<CollectionConfig, "mintStart" | "mintEnd" | "supplyCap">,
  minted: bigint,
  nowSec: number,
): boolean {
  if (cfg.mintStart !== 0n && BigInt(nowSec) < cfg.mintStart) return false
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return false
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return false
  return true
}

/** True when the collection sells exclusively through an authorized minter
 * extension (pooled collections never sell via the built-in paid path). */
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
