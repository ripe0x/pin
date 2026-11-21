/**
 * Where the standalone live view may send a browser for a token whose
 * animation_url is not an inline HTML document.
 *
 * Content-addressed URIs (ipfs://, ipns://, ar://, or a gateway URL that
 * embeds an IPFS CID) are rewritten onto a fixed public gateway. Any other
 * URL is followed only when its host is one of the known IPFS / IPNS /
 * Arweave gateways. Everything else returns null (the route 404s), so the
 * route never redirects to an arbitrary host.
 *
 * Pure: no I/O.
 */
import {
  ARWEAVE_GATEWAYS,
  IPFS_GATEWAYS,
  IPNS_GATEWAYS,
  arweaveToHttp,
  extractCid,
  ipfsToHttp as sharedIpfsToHttp,
} from "@pin/shared"

/** Fixed gateway the live view sends IPFS content to. */
const LIVE_IPFS_GATEWAY = "https://ipfs.io"

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(
  [...IPFS_GATEWAYS, ...IPNS_GATEWAYS, ...ARWEAVE_GATEWAYS].map((g) => new URL(g).host.toLowerCase()),
)

/** Subdomain-style gateway hosts (`<cid>.ipfs.dweb.link`, `<id>.arweave.net`). */
function isAllowedSubdomainHost(host: string): boolean {
  return (
    host.endsWith(".arweave.net") ||
    /^[a-z0-9]+\.ipfs\.dweb\.link$/.test(host) ||
    /^[a-z0-9-]+\.ipns\.dweb\.link$/.test(host)
  )
}

export function isAllowedGatewayUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== "https:") return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  if (u.port && u.port !== "443") return false
  return ALLOWED_HOSTS.has(host) || isAllowedSubdomainHost(host)
}

/** The gateway URL to redirect to for `animationUrl`, or null when none is allowed. */
export function liveRedirectTarget(animationUrl: string): string | null {
  const uri = animationUrl.trim()
  if (!uri) return null
  let target: string
  if (uri.startsWith("ipns://")) {
    target = sharedIpfsToHttp(uri)
  } else if (uri.startsWith("ar://")) {
    target = arweaveToHttp(uri)
  } else if (uri.startsWith("ipfs://") || extractCid(uri) !== null) {
    target = sharedIpfsToHttp(uri, LIVE_IPFS_GATEWAY)
  } else {
    target = uri
  }
  return isAllowedGatewayUrl(target) ? target : null
}
