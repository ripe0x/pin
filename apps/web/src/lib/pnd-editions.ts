/**
 * PND Editions — shared, client-safe helpers.
 *
 * One ERC721A contract == one edition. Constants, enums/labels, ABI-return
 * decoders, and the honest-pricing math used by both server reads
 * (lib/editions-onchain.ts) and client components. No server-only imports.
 */
import { type Address, formatEther, isAddress } from "viem"
import { foundry, mainnet } from "wagmi/chains"
import { PND_EDITIONS_FACTORY, SPLIT_MAIN, getAddressOrNull } from "@pin/addresses"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/** Fixed protocol surface share, in bps. Must match PNDEditions.SURFACE_SHARE_BPS. */
export const SURFACE_SHARE_BPS = 1000 // 10%

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Must match wagmi.ts `forkChain` so wallet/link/chain checks agree. Honors the
// same NEXT_PUBLIC_FORK_CHAIN_ID override (default 31339).
const FORK_CHAIN_ID = Number(process.env.NEXT_PUBLIC_FORK_CHAIN_ID || "31339")
export const PND_CHAIN = FORK_MODE ? foundry : mainnet
export const PND_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : mainnet.id

/** The PNDEditionsFactory address (env override for local dev wins). */
export function pndEditionsFactory(chainId: number = PND_CHAIN_ID): Address | null {
  const env = process.env.NEXT_PUBLIC_PND_EDITIONS_FACTORY
  if (env && isAddress(env)) return env as Address
  return getAddressOrNull(PND_EDITIONS_FACTORY, chainId)
}

/**
 * The surface address PND passes when a mint happens on this app — it receives
 * the fixed surface share. A self-hosted page passes the artist's own address
 * instead (so the artist keeps it). Defaults to zero (PND collects nothing)
 * until a treasury is configured.
 */
export function pndSurfaceAddress(): Address {
  const env = process.env.NEXT_PUBLIC_PND_SURFACE_ADDRESS
  if (env && isAddress(env)) return env as Address
  return ZERO_ADDRESS
}

// ── enums (mirror PNDEditionsTypes.sol) ─────────────────────────────────────

export enum EditionKind {
  Standalone = 0,
  Study = 1,
  Phase = 2,
  Access = 3,
  Source = 4,
  Continuation = 5,
}

export enum EditionStatus {
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
  Edition = 0,
  Token = 1,
  External = 2,
}

export const EDITION_KIND_LABEL: Record<number, string> = {
  [EditionKind.Standalone]: "Standalone",
  [EditionKind.Study]: "Study",
  [EditionKind.Phase]: "Phase",
  [EditionKind.Access]: "Access object",
  [EditionKind.Source]: "Source object",
  [EditionKind.Continuation]: "Continuation",
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

export const EDITION_STATUS_LABEL: Record<number, string> = {
  [EditionStatus.Open]: "Open",
  [EditionStatus.Closing]: "Closing",
  [EditionStatus.Closed]: "Closed",
}

// ── types ─────────────────────────────────────────────────────────────────────

export type EditionConfig = {
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
}

export type Edition = {
  address: Address
  name: string
  symbol: string
  owner: Address
  totalSupply: bigint
  isUpgradeable: boolean
  isSealed: boolean
  isMetadataFrozen: boolean
  cfg: EditionConfig
  status: EditionStatus
  minted: bigint
}

export type EditionMintMark = {
  indexInEdition: number
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

export type EditionEdge = { edgeType: EdgeType; target: EditionRef }
export type EditionPath = { pathType: PathType; target: EditionRef; data: `0x${string}` }

// ── ABI-return decoders ──────────────────────────────────────────────────────

type RawConfig = {
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
}

export function decodeConfig(raw: RawConfig): EditionConfig {
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
  }
}

export function decodeMintMark(raw: {
  // viem decodes <=48-bit uints as number, >48-bit as bigint.
  indexInEdition: number | bigint
  mintBlock: number | bigint
  statusAtMint: number
  surface: Address
  isFirst: boolean
  isFinal: boolean
}): EditionMintMark {
  return {
    indexInEdition: Number(raw.indexInEdition),
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

export function formatPriceLabel(price: bigint): string {
  return isGasOnly(price) ? "Gas only" : `${trimEth(formatEther(price))} ETH`
}

function trimEth(s: string): string {
  if (!s.includes(".")) return s
  return s.replace(/\.?0+$/, "")
}

/**
 * The canonical 0xSplits SplitMain for PND Editions. Editions are mainnet-only,
 * and on a mainnet fork the canonical SplitMain is present at its mainnet
 * address, so resolve to mainnet either way. Returns null if unconfigured.
 */
export function pndSplitMain(): Address | null {
  return getAddressOrNull(SPLIT_MAIN, mainnet.id)
}

/** A collaborator row: an address and an integer percent (1-100). */
export type Collaborator = { address: Address; percent: number }

/**
 * Build sorted 0xSplits `createSplit` args from collaborator rows. 0xSplits
 * requires accounts sorted ascending and allocations on the 1e6 scale (1% =
 * 10_000). Integer percents summing to 100 therefore sum to exactly 1_000_000.
 */
export function buildSplitArgs(rows: Collaborator[]): {
  accounts: Address[]
  allocations: number[]
} {
  const sorted = [...rows].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  )
  return {
    accounts: sorted.map((r) => r.address),
    allocations: sorted.map((r) => r.percent * 10_000),
  }
}

/** Validate collaborator rows for a 0xSplits split (>=2 unique, percents = 100). */
export function validateCollaborators(rows: { address: string; percent: string }[]): {
  ok: boolean
  error: string | null
  parsed: Collaborator[]
} {
  const filled = rows.filter((r) => r.address.trim() !== "" || r.percent.trim() !== "")
  if (filled.length < 2) return { ok: false, error: "Add at least two collaborators", parsed: [] }
  const parsed: Collaborator[] = []
  const seen = new Set<string>()
  for (const r of filled) {
    if (!isAddress(r.address)) return { ok: false, error: "Invalid collaborator address", parsed: [] }
    const lower = r.address.toLowerCase()
    if (seen.has(lower)) return { ok: false, error: "Duplicate collaborator address", parsed: [] }
    seen.add(lower)
    const pct = Number(r.percent)
    if (!Number.isInteger(pct) || pct < 1 || pct > 100)
      return { ok: false, error: "Each share must be a whole number, 1-100", parsed: [] }
    parsed.push({ address: r.address as Address, percent: pct })
  }
  const sum = parsed.reduce((acc, r) => acc + r.percent, 0)
  if (sum !== 100) return { ok: false, error: `Shares must total 100% (now ${sum}%)`, parsed: [] }
  return { ok: true, error: null, parsed }
}

/** The fixed Surface Share split of `total`, out of the price. */
export function splitOutOfPrice(total: bigint, surface: Address): {
  surfaceCut: bigint
  artistCut: bigint
} {
  const surfaceCut =
    surface === ZERO_ADDRESS ? 0n : (total * BigInt(SURFACE_SHARE_BPS)) / 10_000n
  return { surfaceCut, artistCut: total - surfaceCut }
}

export function formatBps(bps: number): string {
  const pct = bps / 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`
}

export function lifecycleStatus(
  cfg: Pick<EditionConfig, "mintEnd" | "supplyCap">,
  minted: bigint,
  contractClosing: boolean,
  nowSec: number,
): EditionStatus {
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return EditionStatus.Closed
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return EditionStatus.Closed
  if (contractClosing) return EditionStatus.Closing
  return EditionStatus.Open
}

export function isMintable(
  cfg: Pick<EditionConfig, "mintStart" | "mintEnd" | "supplyCap">,
  minted: bigint,
  nowSec: number,
): boolean {
  if (cfg.mintStart !== 0n && BigInt(nowSec) < cfg.mintStart) return false
  if (cfg.mintEnd !== 0n && BigInt(nowSec) >= cfg.mintEnd) return false
  if (cfg.supplyCap !== 0n && minted >= cfg.supplyCap) return false
  return true
}

/** Canonical pnd: URN for a node, e.g. pnd:1:0xabc…:e (edition) or :t47 (token). */
export function pndUrn(
  chainId: number,
  contract: Address,
  kind: "e" | "t" | "x",
  id: bigint | number,
): string {
  return `pnd:${chainId}:${contract.toLowerCase()}:${kind}${kind === "e" ? "" : id.toString()}`
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** evm.now address URL, chain-aware (per the project's tx-link rule). */
export function evmNowAddressUrl(addr: string, chainId: number = PND_CHAIN_ID): string {
  return `https://evm.now/address/${addr}?chainId=${chainId}`
}

/** Resolve a Ref to an internal PND route when it points at a PND node. */
export function refToHref(ref: EditionRef): string | null {
  const c = ref.contractAddress
  if (ref.kind === RefKind.Edition) return `/editions/${c}`
  if (ref.kind === RefKind.Token) return `/editions/${c}/${ref.id.toString()}`
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
