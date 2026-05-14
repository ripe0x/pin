import type { Address } from "viem"
import type { RawWork, SkippedWork } from "./types.ts"

/**
 * Pure-data mapper for the Brinkman registry JSON shape. Kept separate
 * from `brinkman.ts` (the fetcher) so the test runner can import this
 * without pulling in `server-only`.
 */

export type BrinkmanArtwork = {
  id?: string
  slug?: string
  title?: string
  year?: number
  edition?: string
  image?: string
  /** Brinkman pins ~57% of works to IPFS — we use this as the
   * primary's fallback when the primary host has issues. */
  ipfsImage?: string
  canonicalUrl?: string
  blockchain?: string
  contractAddress?: string
  tokenId?: string | number
  tokenIdStart?: string | number
  tokenIdEnd?: string | number
  tokenIds?: Array<string | number>
}

const CHAIN_MAP: Record<string, number> = {
  ethereum: 1,
  mainnet: 1,
  base: 8453,
  polygon: 137,
  apechain: 33139,
}

function toChainId(label: string | undefined): number {
  if (!label) return 0
  return CHAIN_MAP[label.toLowerCase()] ?? 0
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

function toAddressOrNull(s: string | undefined): Address | null {
  if (!s) return null
  return ADDRESS_RE.test(s) ? (s.toLowerCase() as Address) : null
}

function toBigIntOrUndef(v: string | number | undefined): bigint | undefined {
  if (v === undefined || v === null) return undefined
  try {
    return BigInt(v)
  } catch {
    return undefined
  }
}

/**
 * Map one Brinkman feed row to either a `RawWork` we can register
 * on-chain, or a `SkippedWork` explaining why it was excluded. Returning
 * a tagged result (instead of `RawWork | null`) is what lets the planner
 * surface "X physical / off-chain works skipped" — the alternative
 * silently dropped these rows.
 */
export type MapResult =
  | { kind: "work"; work: RawWork }
  | { kind: "skip"; skip: SkippedWork }

function skipFor(
  raw: BrinkmanArtwork,
  reason: SkippedWork["reason"],
): MapResult {
  return {
    kind: "skip",
    skip: {
      id: raw.slug || raw.id || raw.title || "unknown",
      title: raw.title || "Untitled",
      reason,
      blockchain: raw.blockchain,
      externalUrl: raw.canonicalUrl,
    },
  }
}

export function mapBrinkmanArtwork(raw: BrinkmanArtwork): MapResult | null {
  const contract = toAddressOrNull(raw.contractAddress)
  const chainId = toChainId(raw.blockchain)

  // No contract at all = either a physical print (no blockchain set) or
  // an off-chain platform (Flow / Tezos / Bitcoin / Ordinals — these CAN
  // have a contract-shaped string but typically don't have an EVM one).
  if (!contract) {
    const bc = (raw.blockchain || "").toLowerCase()
    if (!raw.blockchain) {
      return skipFor(raw, "physical")
    }
    if (bc === "ethereum" || bc === "mainnet" || bc === "base" || bc === "polygon" || bc === "apechain") {
      // An EVM chain claim with no parseable contract address — odd but
      // not addressable. Treat as off-chain so we don't lose track.
      return skipFor(raw, "off-chain")
    }
    return skipFor(raw, "non-evm-chain")
  }

  // Contract present but on a chain we have no mapping for (e.g. someone
  // adds a new EVM chain in their feed that we haven't onboarded yet).
  if (chainId === 0) {
    return skipFor(raw, "non-evm-chain")
  }

  const tokenIdStart = toBigIntOrUndef(raw.tokenIdStart)
  const tokenIdEnd = toBigIntOrUndef(raw.tokenIdEnd)
  const tokenId = toBigIntOrUndef(raw.tokenId)
  const tokenIds = raw.tokenIds
    ?.map(toBigIntOrUndef)
    .filter((v): v is bigint => v !== undefined)

  if (
    tokenIdStart === undefined &&
    tokenIdEnd === undefined &&
    tokenId === undefined &&
    (!tokenIds || tokenIds.length === 0)
  ) {
    // Contract but no tokenId reference — likely a platform listing the
    // mapper can't pin to a specific token. Mark off-chain rather than
    // silently dropping.
    return skipFor(raw, "off-chain")
  }

  // Brinkman's feed often sets `tokenIds` to ALL minted tokens for an
  // edition AND duplicates a representative one in `tokenId`. Prefer
  // the per-token list when it has more than 1 entry — otherwise we'd
  // silently lose edition tokens. Range fields (start/end) take
  // precedence over both when present.
  const useList =
    tokenIdStart === undefined && tokenIds !== undefined && tokenIds.length > 1

  return {
    kind: "work",
    work: {
      id: raw.slug || raw.id || `${contract}:${raw.tokenId ?? raw.tokenIdStart}`,
      title: raw.title || "Untitled",
      chainId,
      contract,
      tokenIdStart,
      tokenIdEnd,
      tokenId: useList ? undefined : tokenId,
      tokenIds: useList ? tokenIds : undefined,
      editionInfo: raw.edition,
      year: raw.year,
      imageUrl: raw.image,
      imageFallbackUrl: toIpfsHttpUrl(raw.ipfsImage),
      externalUrl: raw.canonicalUrl,
    },
  }
}

/**
 * `ipfsImage` is sometimes a bare CID, sometimes `ipfs://CID/...`,
 * sometimes already a full https URL. Normalize to a gateway-served
 * HTTPS URL so the browser can render it directly. We pick a single
 * gateway rather than a multi-gateway race because the fallback only
 * fires when the primary already failed — keeping the second attempt
 * simple makes the failure mode predictable.
 */
function toIpfsHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (v.startsWith("http://") || v.startsWith("https://")) return v
  if (v.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${v.slice("ipfs://".length)}`
  }
  // Bare CIDv0 (Qm…) or CIDv1 (bafy…) — gate behind a loose match.
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[ya][a-z2-7]{50,})/i.test(v)) {
    return `https://ipfs.io/ipfs/${v}`
  }
  return undefined
}
