/**
 * PND Editions — shared, client-safe helpers.
 *
 * Constants, enums/labels, ABI-return decoders, and the honest-pricing math
 * used by both server reads (lib/editions-onchain.ts) and client components
 * (components/editions/*). No server-only imports, so this module is safe to
 * pull into "use client" files.
 */
import { type Address, formatEther, isAddress } from "viem"
import { foundry, mainnet } from "wagmi/chains"
import { PND_EDITIONS_FACTORY, getAddressOrNull } from "@pin/addresses"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

// Mirror tx-ui's PREFERRED_CHAIN selection without importing a client module.
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
export const PND_CHAIN = FORK_MODE ? foundry : mainnet
export const PND_CHAIN_ID = PND_CHAIN.id

/**
 * The PNDEditionsFactory address. An env override (local Anvil dev) wins over
 * the addresses package, which carries the deployed mainnet address.
 */
export function pndEditionsFactory(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_PND_EDITIONS_FACTORY
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(PND_EDITIONS_FACTORY, chainId)
}

/**
 * The surface address PND passes when a mint happens on this app — it receives
 * the artist-allowed Surface Share (never a protocol fee; the artist sets the
 * bps, and zero means PND takes nothing). A self-hosted page passes the
 * artist's own address instead. Defaults to the zero address so PND collects
 * nothing until a treasury is configured.
 */
export function pndSurfaceAddress(): Address {
  const env = process.env.NEXT_PUBLIC_PND_SURFACE_ADDRESS
  if (env && isAddress(env)) return env as Address
  return ZERO_ADDRESS
}

// ── enums (mirror PNDEditionsTypes.sol) ─────────────────────────────────────

export enum ProjectMode {
  ImmutableClone = 0,
  Upgradeable = 1,
}

export enum ReleaseKind {
  Standalone = 0,
  Study = 1,
  Phase = 2,
  Access = 3,
  Source = 4,
  Continuation = 5,
}

export enum ReleaseStatus {
  Open = 0,
  Closing = 1,
  Closed = 2,
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

export enum RefKind {
  Release = 0,
  Token = 1,
  External = 2,
}

export const RELEASE_KIND_LABEL: Record<number, string> = {
  [ReleaseKind.Standalone]: "Standalone",
  [ReleaseKind.Study]: "Study",
  [ReleaseKind.Phase]: "Phase",
  [ReleaseKind.Access]: "Access object",
  [ReleaseKind.Source]: "Source object",
  [ReleaseKind.Continuation]: "Continuation",
}

export const RELEASE_KIND_DESCRIPTION: Record<number, string> = {
  [ReleaseKind.Standalone]: "A self contained release.",
  [ReleaseKind.Study]: "A study toward another release.",
  [ReleaseKind.Phase]: "One phase of a larger, multi phase work.",
  [ReleaseKind.Access]: "Holding a token grants access to another release.",
  [ReleaseKind.Source]: "A source object other releases derive from.",
  [ReleaseKind.Continuation]: "Continues a prior release.",
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

export const RELEASE_STATUS_LABEL: Record<number, string> = {
  [ReleaseStatus.Open]: "Open",
  [ReleaseStatus.Closing]: "Closing",
  [ReleaseStatus.Closed]: "Closed",
}

// ── types (mirror the ABI return shapes) ─────────────────────────────────────

export type EditionReleaseConfig = {
  defaultArtworkURI: string
  price: bigint
  surfaceShareBps: number
  supplyCap: bigint
  mintStart: bigint
  mintEnd: bigint
  royaltyBps: number
  royaltyReceiver: Address
  kind: number
  payoutAddress: Address
  renderer: Address
  mintHook: Address
}

export type EditionRelease = {
  releaseId: number
  cfg: EditionReleaseConfig
  status: ReleaseStatus
  minted: bigint
}

export type EditionMintMark = {
  releaseId: number
  indexInRelease: number
  mintBlock: bigint
  statusAtMint: number
  surface: Address
  isFirst: boolean
  isFinal: boolean
}

export type EditionRef = {
  chainId: number
  contractAddress: Address
  id: bigint
  kind: RefKind
}

export type EditionEdge = {
  edgeType: EdgeType
  target: EditionRef
}

export type EditionPath = {
  pathType: PathType
  target: EditionRef
  data: `0x${string}`
}

export type EditionProject = {
  address: Address
  name: string
  symbol: string
  owner: Address
  totalReleases: number
  totalSupply: bigint
  isUpgradeable: boolean
  isSealed: boolean
}

// ── ABI-return decoders ──────────────────────────────────────────────────────
// viem decodes named structs to objects; named multi-returns to positional
// arrays. These normalize both into the types above.

type RawReleaseCfg = {
  defaultArtworkURI: string
  price: bigint
  surfaceShareBps: number
  supplyCap: bigint
  mintStart: bigint
  mintEnd: bigint
  royaltyBps: number
  royaltyReceiver: Address
  kind: number
  payoutAddress: Address
  renderer: Address
  mintHook: Address
}

export function decodeReleaseConfig(raw: RawReleaseCfg): EditionReleaseConfig {
  return {
    defaultArtworkURI: raw.defaultArtworkURI,
    price: raw.price,
    surfaceShareBps: Number(raw.surfaceShareBps),
    supplyCap: raw.supplyCap,
    mintStart: raw.mintStart,
    mintEnd: raw.mintEnd,
    royaltyBps: Number(raw.royaltyBps),
    royaltyReceiver: raw.royaltyReceiver,
    kind: Number(raw.kind),
    payoutAddress: raw.payoutAddress,
    renderer: raw.renderer,
    mintHook: raw.mintHook,
  }
}

export function decodeMintMark(raw: {
  // viem decodes <=48-bit uints as number, >48-bit as bigint.
  releaseId: number | bigint
  indexInRelease: number | bigint
  mintBlock: number | bigint
  statusAtMint: number
  surface: Address
  isFirst: boolean
  isFinal: boolean
}): EditionMintMark {
  return {
    releaseId: Number(raw.releaseId),
    indexInRelease: Number(raw.indexInRelease),
    mintBlock: BigInt(raw.mintBlock),
    statusAtMint: Number(raw.statusAtMint),
    surface: raw.surface,
    isFirst: raw.isFirst,
    isFinal: raw.isFinal,
  }
}

// ── honest pricing + lifecycle helpers ───────────────────────────────────────

export function isGasOnly(price: bigint): boolean {
  return price === 0n
}

/** Display label for a price: "Gas only" for 0, else "0.01 ETH". Never "free". */
export function formatPriceLabel(price: bigint): string {
  return isGasOnly(price) ? "Gas only" : `${trimEth(formatEther(price))} ETH`
}

function trimEth(s: string): string {
  // strip trailing zeros but keep at least one decimal place readable
  if (!s.includes(".")) return s
  return s.replace(/\.?0+$/, "")
}

/** The Surface Share split of `total`, out of the price (never on top). */
export function splitOutOfPrice(
  total: bigint,
  surfaceShareBps: number,
  surface: Address,
): { surfaceCut: bigint; artistCut: bigint } {
  const surfaceCut =
    surface === ZERO_ADDRESS || surfaceShareBps === 0
      ? 0n
      : (total * BigInt(surfaceShareBps)) / 10_000n
  return { surfaceCut, artistCut: total - surfaceCut }
}

export function formatBps(bps: number): string {
  // 1000 -> "10%", 250 -> "2.5%"
  const pct = bps / 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`
}

/**
 * Derive the lifecycle status the contract would report, given a snapshot.
 * Mirrors PNDEditions._lifecycleStatus so the UI agrees with the chain.
 */
export function lifecycleStatus(
  cfg: Pick<EditionReleaseConfig, "mintEnd" | "supplyCap">,
  minted: bigint,
  contractClosing: boolean,
  nowSec: number,
): ReleaseStatus {
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return ReleaseStatus.Closed
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return ReleaseStatus.Closed
  if (contractClosing) return ReleaseStatus.Closing
  return ReleaseStatus.Open
}

export function isMintable(
  cfg: Pick<EditionReleaseConfig, "mintStart" | "mintEnd" | "supplyCap">,
  minted: bigint,
  nowSec: number,
): boolean {
  if (cfg.mintStart !== 0n && BigInt(nowSec) < cfg.mintStart) return false
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return false
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return false
  return true
}

/** Canonical pnd: URN for a node, e.g. pnd:1:0xabc…:r3 or :t47. */
export function pndUrn(
  chainId: number,
  contract: Address,
  kind: "r" | "t" | "x",
  id: bigint | number,
): string {
  return `pnd:${chainId}:${contract.toLowerCase()}:${kind}${id.toString()}`
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** evm.now address URL, chain-aware (per the project's tx-link rule). */
export function evmNowAddressUrl(addr: string, chainId: number = PND_CHAIN_ID): string {
  return `https://evm.now/address/${addr}?chainId=${chainId}`
}

/** Resolve an artwork URI to an https URL for OG/SSR (ipfs:// → gateway).
 *  Client rendering uses OptimizedImage, which has its own gateway cascade. */
export function ipfsToHttp(uri: string): string {
  if (!uri) return uri
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length).replace(/^ipfs\//, "")}`
  }
  return uri
}

/** Resolve a Ref to an internal PND route when it points at a PND node. */
export function refToHref(ref: EditionRef): string | null {
  const c = ref.contractAddress
  if (ref.kind === RefKind.Release) return `/editions/${c}/${ref.id.toString()}`
  if (ref.kind === RefKind.Token) return `/editions/${c}/token/${ref.id.toString()}`
  return null
}
