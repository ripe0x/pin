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
 *   - `ipfs://https://<gateway>/ipfs/<cid>[/<path>]` (minter pasted a full
 *     gateway URL into a field the contract prefixes with `ipfs://` — seen
 *     on Foundation shared-contract mints)
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
    // Nested gateway URL: the remainder is itself an HTTP URL, so peel
    // the ipfs:// and extract from the embedded gateway form instead.
    if (cid.startsWith("http://") || cid.startsWith("https://")) {
      return extractCid(cid)
    }
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
 *   ipfs://https://<gw>/ipfs/<cid>[/...]→ <cid>  (pasted gateway URL)
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

  // Nested gateway URL (minter pasted an HTTPS URL into a field the
  // contract prefixes with ipfs://): peel the scheme and re-extract.
  const nested = /^ipfs:\/\/(?:ipfs\/)?(https?:\/\/.+)/i.exec(trimmed)
  if (nested) return extractBareCid(nested[1])

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

// Arweave transaction IDs are 43-character URL-safe base64:
//   characters from [A-Za-z0-9_-], length 43.
// As with CIDs, we don't validate the underlying hash — just the
// shape, so a malformed ID becomes a 404 at the gateway like any
// real-but-unavailable resource.
const ARWEAVE_ID_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * Extract the bare Arweave transaction ID from a URI.
 *
 * Recognised shapes:
 *   ar://<id>[/...]                       → <id>
 *   https://arweave.net/<id>[/...]        → <id>
 *   https://<sub>.arweave.net/<id>[/...]  → <id>
 *
 * Returns null for non-Arweave URIs or URIs whose id-shaped slot
 * fails the 43-char base64url check. Pure function; no I/O.
 *
 * Returned IDs are usable as cache keys for the same
 * `cid_availability` table that IPFS CIDs land in — they're
 * distinguishable from CIDs by character set (CIDs start with `Qm`
 * or `b` and are longer than 43 chars).
 */
export function extractArweaveId(uri: string | null): string | null {
  if (!uri) return null
  const trimmed = uri.trim()
  if (!trimmed) return null

  const arScheme = /^ar:\/\/([^/?#]+)/i.exec(trimmed)
  if (arScheme) return ARWEAVE_ID_RE.test(arScheme[1]) ? arScheme[1] : null

  if (!/^https?:\/\//i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== "arweave.net" && !host.endsWith(".arweave.net")) return null

  // Path is `/<id>[/...]`. The first non-empty segment is the tx id.
  const pathMatch = /^\/([^/?#]+)/.exec(parsed.pathname)
  if (!pathMatch) return null
  return ARWEAVE_ID_RE.test(pathMatch[1]) ? pathMatch[1] : null
}

/**
 * Public Arweave / ar.io gateways, ordered by preference. arweave.net is
 * canonical and fastest once it has seeded a bundle, but a freshly-uploaded
 * (or optimistically-served, not-yet-L1-posted) bundle can 404 on arweave.net
 * for hours while other ar.io gateways that received the data already serve
 * it — the exact failure that pins a fresh Arweave-hosted token on a blank
 * placeholder. Mirrors IPFS_GATEWAYS: try each in turn, first 200 wins.
 * Content is content-addressed by tx id (and, for MURI-anchored media, an
 * on-chain SHA-256), so any gateway serving the file is equivalent.
 */
export const ARWEAVE_GATEWAYS = [
  "https://arweave.net",
  "https://vilenarios.com",
  "https://frostor.xyz",
  "https://permagate.io",
] as const

const DEFAULT_ARWEAVE_GATEWAY = ARWEAVE_GATEWAYS[0]

const ARWEAVE_GATEWAY_HOSTS = new Set(
  ARWEAVE_GATEWAYS.map((g) => new URL(g).host),
)

function isArweaveHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === "arweave.net" || h.endsWith(".arweave.net") || ARWEAVE_GATEWAY_HOSTS.has(h)
}

/**
 * Extract the Arweave tx id PLUS any trailing path from a URI, preserving the
 * path-manifest sub-path (`<manifestId>/5`) that `extractArweaveId` drops.
 * Unlike `extractArweaveId` (bare id, for cache keys), this returns the full
 * `<id>[/<path>]` needed to rebuild a gateway URL.
 *
 * Recognized shapes (first path segment must be a 43-char base64url id, and
 * for HTTP URLs the host must be an Arweave/ar.io gateway — so a URL already
 * rotated onto a fallback gateway still re-extracts, which is what lets the
 * client image cascade advance):
 *   ar://<id>[/<path>]
 *   https://arweave.net/<id>[/<path>]
 *   https://<sub>.arweave.net/<id>[/<path>]
 *   https://<known-arweave-gateway>/<id>[/<path>]
 *
 * Returns `<id>[/<path>]` (query/fragment dropped) or null.
 */
export function extractArweavePath(uri: string | null): string | null {
  if (!uri) return null
  const trimmed = uri.trim()
  if (!trimmed) return null

  const arScheme = /^ar:\/\/(.+)$/i.exec(trimmed)
  if (arScheme) {
    const path = arScheme[1].split(/[?#]/)[0].replace(/^\/+/, "")
    const id = path.split("/")[0]
    return ARWEAVE_ID_RE.test(id) ? path : null
  }

  if (!/^https?:\/\//i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (!isArweaveHost(parsed.hostname)) return null
  const path = parsed.pathname.replace(/^\/+/, "")
  const id = path.split("/")[0]
  return ARWEAVE_ID_RE.test(id) ? path : null
}

/** Build a gateway URL from an Arweave `<id>[/<path>]`. */
export function arweaveToGatewayUrl(
  idAndPath: string,
  gateway: string = DEFAULT_ARWEAVE_GATEWAY,
): string {
  return `${gateway}/${idAndPath}`
}

/**
 * Convert an `ar://` or Arweave-gateway URL to an HTTP gateway URL on the
 * preferred gateway. Non-Arweave URLs are returned unchanged.
 */
export function arweaveToHttp(uri: string, gateway?: string): string {
  const path = extractArweavePath(uri)
  if (!path) return uri
  return arweaveToGatewayUrl(path, gateway ?? DEFAULT_ARWEAVE_GATEWAY)
}

/**
 * Expand one Arweave `<id>[/<path>]` into an ordered list of gateway URLs —
 * the Arweave analog of `ipfsCidToFallbackUrls`.
 */
export function arweavePathToFallbackUrls(
  idAndPath: string,
  gateways: readonly string[] = ARWEAVE_GATEWAYS,
): string[] {
  const clean = extractArweavePath(idAndPath) ?? idAndPath
  return gateways.map((g) => arweaveToGatewayUrl(clean, g))
}

/**
 * Fetch content from Arweave, trying multiple gateways in sequence.
 * Returns the first successful Response, or throws if all fail. Mirrors
 * `fetchFromIpfs`.
 */
export async function fetchFromArweave(
  idAndPath: string,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    headers?: HeadersInit
    cache?: RequestCache
  },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 8_000

  for (const gateway of ARWEAVE_GATEWAYS) {
    try {
      const url = arweaveToGatewayUrl(idAndPath, gateway)
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
        // arweave.net path-manifest access 302-redirects to a sandbox
        // subdomain; follow it.
        redirect: "follow",
      })
      clearTimeout(timeout)

      if (res.ok) return res
    } catch {
      // Try next gateway
    }
  }

  throw new Error(`Failed to fetch Arweave content for: ${idAndPath}`)
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
 * Expand one pinned CID into an ordered list of independent gateway URLs.
 *
 * This is how a single upload becomes a resilient multi-URI set for MURI:
 * each gateway resolves the same content-addressed CID, so if one gateway
 * disappears the others still serve the byte-identical artwork (and MURI's
 * on-chain SHA-256 hash proves it's the real file). Order matches
 * IPFS_GATEWAYS (most reliable first) so index 0 is the preferred source.
 */
export function ipfsCidToFallbackUrls(
  cid: string,
  gateways: readonly string[] = IPFS_GATEWAYS,
): string[] {
  const clean = extractCid(cid) ?? cid
  return gateways.map((g) => ipfsToGatewayUrl(clean, g))
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
