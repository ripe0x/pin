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
  SOVEREIGN_COLLECTION_FACTORY,
  getAddressOrNull,
} from "@pin/addresses"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/** Fixed protocol surface share, in bps. Must match SovereignCollection.SURFACE_SHARE_BPS. */
export const SURFACE_SHARE_BPS = 1000 // 10%

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Must match wagmi.ts `forkChain` (31339) so wallet/link/chain checks agree.
const FORK_CHAIN_ID = 31339
export const PND_CHAIN = FORK_MODE ? foundry : mainnet
export const PND_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : mainnet.id

/** The SovereignCollectionFactory address (env override for local dev wins). */
export function sovereignCollectionFactory(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_SOVEREIGN_COLLECTION_FACTORY
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(SOVEREIGN_COLLECTION_FACTORY, chainId)
}

/** The Attribution singleton address (env override for local dev wins). */
export function attributionAddress(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_ATTRIBUTION
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(ATTRIBUTION, chainId)
}

/**
 * The surface address PND passes when a mint happens on this app — it
 * receives the fixed surface share. A self-hosted page passes the artist's
 * own address instead (so the artist keeps it). Defaults to zero (PND
 * collects nothing) until a treasury is configured.
 */
export function pndSurfaceAddress(): Address {
  const env = process.env.NEXT_PUBLIC_PND_SURFACE_ADDRESS
  if (env && isAddress(env)) return env as Address
  return ZERO_ADDRESS
}

// ── enums (mirror CollectionTypes.sol) ──────────────────────────────────────

export enum CollectionKind {
  Standalone = 0,
  Study = 1,
  Phase = 2,
  Access = 3,
  Source = 4,
  Continuation = 5,
}

export enum CollectionStatus {
  Open = 0,
  Closing = 1,
  Closed = 2,
}

export enum IdMode {
  Sequential = 0,
  Pooled = 1,
}

export enum Liveness {
  Pure = 0,
  ChainLive = 1,
  ExternalLive = 2,
}

export enum EdgeType {
  BelongsTo = 0,
  StudyOf = 1,
  PhaseOf = 2,
  Continues = 3,
  Source = 4,
  Access = 5,
}

export enum PathType {
  None = 0,
  Continuation = 1,
  Migration = 2,
  Claim = 3,
  Reveal = 4,
  Burn = 5,
  Custom = 6,
}

export enum CodeKind {
  Script = 0,
  ScriptGzip = 1,
}

export enum RefKind {
  Collection = 0,
  Token = 1,
  External = 2,
}

export const COLLECTION_KIND_LABEL: Record<number, string> = {
  [CollectionKind.Standalone]: "Standalone",
  [CollectionKind.Study]: "Study",
  [CollectionKind.Phase]: "Phase",
  [CollectionKind.Access]: "Access object",
  [CollectionKind.Source]: "Source object",
  [CollectionKind.Continuation]: "Continuation",
}

export const COLLECTION_STATUS_LABEL: Record<number, string> = {
  [CollectionStatus.Open]: "Open",
  [CollectionStatus.Closing]: "Closing",
  [CollectionStatus.Closed]: "Closed",
}

export const ID_MODE_LABEL: Record<number, string> = {
  [IdMode.Sequential]: "Sequential",
  [IdMode.Pooled]: "Pooled",
}

export const LIVENESS_LABEL: Record<number, string> = {
  [Liveness.Pure]: "Pure",
  [Liveness.ChainLive]: "Onchain live",
  [Liveness.ExternalLive]: "External live",
}

export const EDGE_TYPE_LABEL: Record<number, string> = {
  [EdgeType.BelongsTo]: "Belongs to",
  [EdgeType.StudyOf]: "Study of",
  [EdgeType.PhaseOf]: "Phase of",
  [EdgeType.Continues]: "Continues",
  [EdgeType.Source]: "Source for",
  [EdgeType.Access]: "Grants access to",
}

export const PATH_TYPE_LABEL: Record<number, string> = {
  [PathType.None]: "None",
  [PathType.Continuation]: "Continuation",
  [PathType.Migration]: "Migration",
  [PathType.Claim]: "Claim",
  [PathType.Reveal]: "Reveal",
  [PathType.Burn]: "Burn",
  [PathType.Custom]: "Custom",
}

export const CODE_KIND_LABEL: Record<number, string> = {
  [CodeKind.Script]: "Script",
  [CodeKind.ScriptGzip]: "Script (gzip)",
}

// ── types (mirror CollectionTypes.sol structs) ──────────────────────────────

export type Ref = {
  chainId: number
  contractAddress: Address
  id: bigint
  kind: RefKind
}

export type Edge = { edgeType: EdgeType; target: Ref }
export type Path = { pathType: PathType; target: Ref; data: `0x${string}` }

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
  liveness: Liveness
  injectionVersion: number
  renderParams: string
}

export type CollectionConfig = {
  artworkURI: string
  price: bigint
  supplyCap: bigint
  mintStart: bigint
  mintEnd: bigint
  royaltyBps: number
  royaltyReceiver: Address
  kind: CollectionKind
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
  isWorkLocked: boolean
  isMetadataFrozen: boolean
  isPermanent: boolean
  renderer: Address
  priceStrategy: Address
  cfg: CollectionConfig
  status: CollectionStatus
  minted: bigint
}

export type MintMark = {
  mintIndex: number
  mintBlock: bigint
  statusAtMint: CollectionStatus
  surface: Address
  isFirst: boolean
  isFinal: boolean
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
  liveness: number
  injectionVersion: number
  renderParams: string
}

export function decodeWorkConfig(raw: RawWorkConfig): WorkConfig {
  return {
    code: raw.code.map(decodeCodeRef),
    deps: raw.deps.map(decodeCodeRef),
    codeURI: raw.codeURI,
    codeHash: raw.codeHash,
    liveness: Number(raw.liveness),
    injectionVersion: Number(raw.injectionVersion),
    renderParams: raw.renderParams,
  }
}

type RawCollectionConfig = {
  artworkURI: string
  price: bigint
  supplyCap: bigint
  mintStart: bigint
  mintEnd: bigint
  royaltyBps: number
  royaltyReceiver: Address
  kind: number
  payoutAddress: Address
  renderer: Address
  mintHook: Address
  priceStrategy: Address
  idMode: number
}

export function decodeCollectionConfig(raw: RawCollectionConfig): CollectionConfig {
  return {
    artworkURI: raw.artworkURI,
    price: raw.price,
    supplyCap: raw.supplyCap,
    mintStart: raw.mintStart,
    mintEnd: raw.mintEnd,
    royaltyBps: Number(raw.royaltyBps),
    royaltyReceiver: raw.royaltyReceiver,
    kind: Number(raw.kind),
    payoutAddress: raw.payoutAddress,
    renderer: raw.renderer,
    mintHook: raw.mintHook,
    priceStrategy: raw.priceStrategy,
    idMode: Number(raw.idMode),
  }
}

export function decodeMintMark(raw: {
  // viem decodes <=48-bit uints as number, >48-bit as bigint.
  mintIndex: number | bigint
  mintBlock: number | bigint
  statusAtMint: number
  surface: Address
  isFirst: boolean
  isFinal: boolean
}): MintMark {
  return {
    mintIndex: Number(raw.mintIndex),
    mintBlock: BigInt(raw.mintBlock),
    statusAtMint: Number(raw.statusAtMint) as CollectionStatus,
    surface: raw.surface,
    isFirst: raw.isFirst,
    isFinal: raw.isFinal,
  }
}

type RawRef = {
  chainId: number | bigint
  contractAddress: Address
  id: bigint
  kind: number
}

export function decodeRef(raw: RawRef): Ref {
  return {
    chainId: Number(raw.chainId),
    contractAddress: raw.contractAddress,
    id: raw.id,
    kind: Number(raw.kind) as RefKind,
  }
}

export function decodeEdge(raw: { edgeType: number; target: RawRef }): Edge {
  return { edgeType: Number(raw.edgeType) as EdgeType, target: decodeRef(raw.target) }
}

export function decodePath(raw: {
  pathType: number
  target: RawRef
  data: `0x${string}`
}): Path {
  return {
    pathType: Number(raw.pathType) as PathType,
    target: decodeRef(raw.target),
    data: raw.data,
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

export function lifecycleStatus(
  cfg: Pick<CollectionConfig, "mintEnd" | "supplyCap">,
  minted: bigint,
  contractClosing: boolean,
  nowSec: number,
): CollectionStatus {
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return CollectionStatus.Closed
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return CollectionStatus.Closed
  if (contractClosing) return CollectionStatus.Closing
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

/** Resolve a Ref to an internal PND route when it points at a PND node. */
export function refToHref(ref: Ref): string | null {
  const c = ref.contractAddress
  if (ref.kind === RefKind.Collection) return `/collections/${c}`
  if (ref.kind === RefKind.Token) return `/collections/${c}/${ref.id.toString()}`
  return null
}

/** Resolve an artwork URI to an https URL for OG/SSR (ipfs:// → gateway). */
export function ipfsToHttp(uri: string): string {
  if (!uri) return uri
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length).replace(/^ipfs\//, "")}`
  }
  return uri
}
