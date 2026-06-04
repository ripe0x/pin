/**
 * Pure URL → HostBucket classifier. Used by the dependency report's
 * Display path section to summarise where each token's metadata JSON
 * and media live (IPFS / Arweave / on-chain / centralized HTTP).
 *
 * No I/O. Easy to unit-test. Bucket rules:
 *   - `ipfs://…`                                     → ipfs
 *   - host matches known IPFS gateway pattern        → ipfs
 *   - `ar://…` or arweave.net host                   → arweave
 *   - `data:application/json` or `data:image/…`      → onchain
 *   - any other http(s)://…                          → centralized (host populated)
 *   - null / empty / unparseable                     → unresolved
 */

export type HostBucket = "ipfs" | "arweave" | "onchain" | "centralized" | "unresolved"

export type UrlClassification = {
  bucket: HostBucket
  host?: string
}

export type TokenHostFingerprint = {
  metadata: UrlClassification
  media: UrlClassification
}

const IPFS_GATEWAY_HOSTS = new Set([
  "ipfs.io",
  "dweb.link",
  "w3s.link",
  "cf-ipfs.com",
  "nftstorage.link",
  "gateway.pinata.cloud",
])

// Subdomain-style IPFS gateways serve content as `<cid>.ipfs.<gateway>`.
// Matching any host that contains `.ipfs.` covers the common pattern
// (nftstorage.link, w3s.link, dweb.link, cf-ipfs.com, etc.) plus any
// other gateway following the convention.
const IPFS_SUBDOMAIN_PATTERN = /\.ipfs\./i

function isIpfsGatewayHost(host: string): boolean {
  const h = host.toLowerCase()
  if (IPFS_GATEWAY_HOSTS.has(h)) return true
  return IPFS_SUBDOMAIN_PATTERN.test(h)
}

export function classifyUrl(url: string | null): UrlClassification {
  if (!url) return { bucket: "unresolved" }
  const trimmed = url.trim()
  if (!trimmed) return { bucket: "unresolved" }

  const lower = trimmed.toLowerCase()

  if (lower.startsWith("ipfs://")) return { bucket: "ipfs" }
  if (lower.startsWith("ar://")) return { bucket: "arweave" }
  if (lower.startsWith("data:application/json") || lower.startsWith("data:image/")) {
    return { bucket: "onchain" }
  }

  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    let host: string
    try {
      host = new URL(trimmed).hostname
    } catch {
      return { bucket: "unresolved" }
    }
    if (!host) return { bucket: "unresolved" }
    const hostLower = host.toLowerCase()
    if (hostLower === "arweave.net" || hostLower.endsWith(".arweave.net")) {
      return { bucket: "arweave" }
    }
    if (isIpfsGatewayHost(hostLower)) return { bucket: "ipfs" }
    return { bucket: "centralized", host: hostLower }
  }

  return { bucket: "unresolved" }
}

export function fingerprintToken(row: {
  rawUri: string | null
  imageUrl: string | null
  animationUrl: string | null
}): TokenHostFingerprint {
  return {
    metadata: classifyUrl(row.rawUri),
    media: classifyUrl(row.imageUrl ?? row.animationUrl),
  }
}

// Re-export the bare-CID and Arweave-id extractors from @pin/shared
// so the dependency report's preservation reader and the worker
// probe task pull from the same source. (The shared module's
// existing `extractCid` returns CID+path for rendering; preservation
// needs the bare id as a cache key.)
export { extractBareCid, extractArweaveId } from "@pin/shared"
