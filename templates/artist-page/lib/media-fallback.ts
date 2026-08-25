/**
 * Multi-gateway fallback helpers for IPFS- and Arweave-hosted media.
 *
 * Standalone copy for this template — it deliberately carries no monorepo
 * (`@pin/*`) dependencies. Mirrors PND's `@pin/shared` gateway logic: a single
 * hard-coded gateway 404s a freshly-uploaded (or optimistically-served, not
 * yet L1-posted) bundle while other gateways already serve the byte-identical
 * file, so we always keep an ordered fallback list rather than trusting one
 * host. Pure functions only (no React, no `server-only`) so both the
 * server-side metadata resolver and the client image components can import it.
 */

// Path-form gateways so a resolved URL is `${gateway}${cidPath}`. Keep the
// first entry an image host allowed in next.config.ts.
export const IPFS_GATEWAYS = [
  "https://ipfs.filebase.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
]

// Gateway URLs embedded in old metadata should move onto the current primary
// too. dweb.link is intentionally legacy-only: its browser challenge returns
// HTML in place of media, even while server-side requests still get the file.
const IPFS_GATEWAY_HOSTS = new Set([
  ...IPFS_GATEWAYS.map((g) => new URL(g).host),
  "dweb.link",
  "w3s.link",
  "ipfs.io",
  "nftstorage.link",
])

// Arweave / ar.io gateways, arweave.net first (canonical, fastest once a
// bundle is seeded). The rest serve bundles that arweave.net hasn't indexed
// yet — the exact case that otherwise blanks a fresh Arweave-hosted token.
export const ARWEAVE_GATEWAYS = [
  "https://arweave.net",
  "https://vilenarios.com",
  "https://frostor.xyz",
  "https://permagate.io",
]

// Arweave tx ids are 43-char URL-safe base64. We only shape-check; a
// malformed id just 404s at the gateway like any missing resource.
const ARWEAVE_ID_RE = /^[A-Za-z0-9_-]{43}$/
const ARWEAVE_GATEWAY_HOSTS = new Set(
  ARWEAVE_GATEWAYS.map((g) => new URL(g).host),
)

function isArweaveHost(host: string): boolean {
  const h = host.toLowerCase()
  return (
    h === "arweave.net" ||
    h.endsWith(".arweave.net") ||
    ARWEAVE_GATEWAY_HOSTS.has(h)
  )
}

/**
 * Return `<id>[/<path>]` for an `ar://` or Arweave-gateway URL, else null.
 * Preserves path-manifest sub-paths (`<manifestId>/5`). Recognizes a URL
 * already rotated onto a fallback gateway, so the client cascade can advance.
 */
export function extractArweavePath(uri: string): string | null {
  const trimmed = uri.trim()
  if (!trimmed) return null

  const ar = /^ar:\/\/(.+)$/i.exec(trimmed)
  if (ar) {
    const path = ar[1].split(/[?#]/)[0].replace(/^\/+/, "")
    return ARWEAVE_ID_RE.test(path.split("/")[0]) ? path : null
  }

  if (!/^https?:\/\//i.test(trimmed)) return null
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (!isArweaveHost(u.hostname)) return null
  const path = u.pathname.replace(/^\/+/, "")
  return ARWEAVE_ID_RE.test(path.split("/")[0]) ? path : null
}

/**
 * Return the IPFS `<cidPath>` (path + query preserved) for `ipfs://` or any
 * `/ipfs/` gateway URL, else null.
 */
export function extractIpfsPath(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    return uri.slice("ipfs://".length).replace(/^ipfs\//, "") || null
  }
  const idx = uri.search(/\/ipfs\//)
  if (idx === -1) return null
  return uri.slice(idx + "/ipfs/".length) || null
}

/**
 * Expand a metadata/media URI into an ordered list of gateway URLs to try.
 * IPFS and Arweave get their full gateway lists; anything else (plain HTTPS,
 * `data:`) is returned unchanged as a single candidate.
 */
export function gatewayCandidates(uri: string): string[] {
  const ipfs = extractIpfsPath(uri)
  if (ipfs) return IPFS_GATEWAYS.map((g) => g + ipfs)
  const ar = extractArweavePath(uri)
  if (ar) return ARWEAVE_GATEWAYS.map((g) => `${g}/${ar}`)
  return [uri]
}

/**
 * Rewrite a media URL to a browser-loadable primary gateway URL. `ipfs://`
 * and `ar://` schemes (which `<img>` can't load) are resolved to the first
 * gateway; `data:` and already-HTTP(S) URLs pass through. The client
 * `useMediaFallback` hook rotates to later gateways on error.
 */
export function resolveMediaUrl(uri: string): string {
  const ipfs = extractIpfsPath(uri)
  if (ipfs) {
    if (uri.startsWith("ipfs://")) return IPFS_GATEWAYS[0] + ipfs
    try {
      if (IPFS_GATEWAY_HOSTS.has(new URL(uri).host)) {
        return IPFS_GATEWAYS[0] + ipfs
      }
    } catch {
      // Non-URL input falls through unchanged below.
    }
  }
  const ar = extractArweavePath(uri)
  if (ar && uri.startsWith("ar://")) return `${ARWEAVE_GATEWAYS[0]}/${ar}`
  return uri
}
