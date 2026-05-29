/**
 * Shared IPFS utilities for pin.
 *
 * Consolidates IPFS URI handling that was previously duplicated across
 * the web app, indexer, and API routes.
 */

/** Public IPFS gateways, ordered by reliability. cloudflare-ipfs.com was
 * discontinued — `curl https://cloudflare-ipfs.com/...` returns nothing. */
export const IPFS_GATEWAYS = [
  "https://nftstorage.link",
  "https://dweb.link",
  "https://ipfs.io",
  "https://w3s.link",
] as const

const DEFAULT_GATEWAY = IPFS_GATEWAYS[0]

// IPNS (mutable name → CID pointer) needs a gateway that resolves the
// name, not just pins a CID. nftstorage.link / w3s.link are CID-scoped
// and 404 on arbitrary IPNS names, so IPNS uses its own gateway list.
// ipfs.io serves IPNS path-style (`/ipns/<name>`); dweb.link 301-redirects
// to a subdomain, which `fetch` follows automatically.
export const IPNS_GATEWAYS = [
  "https://ipfs.io",
  "https://dweb.link",
] as const

const DEFAULT_IPNS_GATEWAY = IPNS_GATEWAYS[0]

// Permissive matcher for both v0 (Qm…) and v1 (bafy…/bafk…/bafz…) CIDs.
// We don't validate length / character set strictly — public gateways do
// that for us, and any false positive just produces a 404 we'd handle
// the same way we handle a missing image today.
const CID_RE = /(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{50,})/

/**
 * Extract the raw CID (+ optional path) from a URI.
 *
 * Recognized forms:
 *   - `ipfs://<cid>[/<path>]`
 *   - `ipfs://ipfs/<cid>[/<path>]` (Foundation's double-prefix bug)
 *   - `https://<gateway>/ipfs/<cid>[/<path>]` (any HTTP IPFS gateway —
 *     custom Pinata domains, ipfs.io, dweb.link, etc.). Covers tokens
 *     whose metadata embeds gateway URLs with hotlink protection that
 *     would otherwise return 403.
 *
 * Returns `null` if no CID is found.
 */
export function extractCid(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    let cid = uri.replace("ipfs://", "")
    // Fix Foundation's double-prefix bug: ipfs://ipfs/Qm...
    if (cid.startsWith("ipfs/")) cid = cid.replace("ipfs/", "")
    return cid || null
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    // Look for `/ipfs/<cid>` in the path. Anything after the CID is
    // treated as a sub-path and preserved on the rebuilt gateway URL.
    const ipfsIdx = uri.search(/\/ipfs\//)
    if (ipfsIdx === -1) return null
    const tail = uri.slice(ipfsIdx + "/ipfs/".length)
    const m = tail.match(CID_RE)
    if (!m || m.index !== 0) return null
    // Preserve the rest of the path (e.g. /CCU1007.png) and any query.
    return tail
  }
  return null
}

// CIDs come in two shapes:
//   v0: `Qm` + 44 base58 chars (length 46)
//   v1: `b` + lowercase base32 (length 59 for the common bafy/bafk root)
// We don't try to *validate* the multihash — we just identify the
// prefix shape. The consumers (the preservation probe and the
// dependency-report reader) treat anything that doesn't match as
// non-IPFS, which is the right default.
const CIDV0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/
const CIDV1_RE = /^b[A-Za-z2-7]{58,}$/

function looksLikeCid(token: string): boolean {
  return CIDV0_RE.test(token) || CIDV1_RE.test(token)
}

/**
 * Extract the BARE IPFS CID (no path / query / fragment) from a URI.
 *
 * Unlike `extractCid` above — which preserves the trailing path so
 * callers can rebuild a gateway URL — this returns just the CID, so
 * it can be used as a cache key for "is this CID retrievable?"
 * style lookups.
 *
 * Recognised shapes:
 *   ipfs://<cid>[/...]                  → <cid>
 *   ipfs://ipfs/<cid>[/...]             → <cid>  (Foundation double-prefix)
 *   https://<gateway>/ipfs/<cid>[/...]  → <cid>  (path gateway)
 *   https://<cid>.ipfs.<gateway>/...    → <cid>  (subdomain gateway)
 *
 * Returns null for non-IPFS URIs or URIs whose CID-shaped slot fails
 * the v0 / v1 shape check. Pure function; no I/O.
 */
export function extractBareCid(uri: string | null): string | null {
  if (!uri) return null
  const trimmed = uri.trim()
  if (!trimmed) return null

  const ipfsScheme = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)/i.exec(trimmed)
  if (ipfsScheme) return looksLikeCid(ipfsScheme[1]) ? ipfsScheme[1] : null

  if (!/^https?:\/\//i.test(trimmed)) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  // Subdomain gateway: <cid>.ipfs.<rest>
  const subdomain = /^([^.]+)\.ipfs\./i.exec(parsed.hostname)
  if (subdomain && looksLikeCid(subdomain[1])) return subdomain[1]

  // Path gateway: /ipfs/<cid>/...
  const pathMatch = /^\/ipfs\/([^/?#]+)/i.exec(parsed.pathname)
  if (pathMatch && looksLikeCid(pathMatch[1])) return pathMatch[1]

  return null
}

/**
 * Extract the IPNS name (+ optional path) from a URI.
 *
 * Recognized forms:
 *   - `ipns://<name>[/<path>]`
 *   - `https://<gateway>/ipns/<name>[/<path>]`
 *
 * The name may be an IPNS key (`k51…` libp2p-key CID) or a DNSLink domain.
 * We don't validate it — the gateway does. Returns `null` if not IPNS.
 */
export function extractIpnsPath(uri: string): string | null {
  if (uri.startsWith("ipns://")) {
    const rest = uri.slice("ipns://".length)
    return rest || null
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const idx = uri.search(/\/ipns\//)
    if (idx === -1) return null
    const tail = uri.slice(idx + "/ipns/".length)
    return tail || null
  }
  return null
}

/**
 * Build an IPNS gateway URL from a name (+ optional path).
 */
export function ipnsToGatewayUrl(
  nameAndPath: string,
  gateway: string = DEFAULT_IPNS_GATEWAY,
): string {
  return `${gateway}/ipns/${nameAndPath}`
}

/**
 * Build a gateway URL from a raw CID.
 */
export function ipfsToGatewayUrl(
  cid: string,
  gateway: string = DEFAULT_GATEWAY,
): string {
  return `${gateway}/ipfs/${cid}`
}

/**
 * Convert an IPFS or IPNS URI to an HTTP gateway URL.
 * Non-IPFS/IPNS URIs are returned as-is.
 */
export function ipfsToHttp(uri: string, gateway?: string): string {
  // IPNS first: an `ipns://` URI has no CID for extractCid to find, so
  // it would otherwise fall through unchanged and never render.
  if (uri.startsWith("ipns://")) {
    const path = extractIpnsPath(uri)
    return path ? ipnsToGatewayUrl(path, DEFAULT_IPNS_GATEWAY) : uri
  }
  const cid = extractCid(uri)
  if (!cid) return uri
  return ipfsToGatewayUrl(cid, gateway ?? DEFAULT_GATEWAY)
}

/**
 * Fetch content from IPFS, trying multiple gateways in sequence.
 * Returns the first successful Response, or throws if all fail.
 *
 * `headers` and `cache` are forwarded to fetch() — useful for metadata reads
 * that need a browser User-Agent (some CDNs serve HTML to bare server fetches)
 * or `cache: "no-store"` to bypass Next.js's fetch cache.
 */
export async function fetchFromIpfs(
  cid: string,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    headers?: HeadersInit
    cache?: RequestCache
  },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 5_000

  for (const gateway of IPFS_GATEWAYS) {
    try {
      const url = ipfsToGatewayUrl(cid, gateway)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      // If caller provides a signal, abort when either fires
      if (options?.signal) {
        options.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        })
      }

      const res = await fetch(url, {
        signal: controller.signal,
        headers: options?.headers,
        cache: options?.cache,
      })
      clearTimeout(timeout)

      if (res.ok) return res
    } catch {
      // Try next gateway
    }
  }

  throw new Error(`Failed to fetch IPFS content for CID: ${cid}`)
}

/**
 * Fetch content from IPNS, trying IPNS-capable gateways in sequence.
 * `nameAndPath` is what `extractIpnsPath` returns (`<name>[/<path>]`).
 * Returns the first successful Response, or throws if all fail.
 */
export async function fetchFromIpns(
  nameAndPath: string,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    headers?: HeadersInit
    cache?: RequestCache
  },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 5_000

  for (const gateway of IPNS_GATEWAYS) {
    try {
      const url = ipnsToGatewayUrl(nameAndPath, gateway)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      if (options?.signal) {
        options.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        })
      }

      const res = await fetch(url, {
        signal: controller.signal,
        headers: options?.headers,
        cache: options?.cache,
        // dweb.link 301-redirects IPNS to a subdomain; follow it.
        redirect: "follow",
      })
      clearTimeout(timeout)

      if (res.ok) return res
    } catch {
      // Try next gateway
    }
  }

  throw new Error(`Failed to fetch IPNS content for: ${nameAndPath}`)
}
