/**
 * Shared IPFS utilities for pin.
 *
 * Consolidates IPFS URI handling that was previously duplicated across
 * the web app, indexer, and API routes.
 */

/** Public IPFS gateways, ordered by reliability. */
export const IPFS_GATEWAYS = [
  "https://nftstorage.link",
  "https://cloudflare-ipfs.com",
  "https://dweb.link",
  "https://ipfs.io",
] as const

const DEFAULT_GATEWAY = IPFS_GATEWAYS[0]

/**
 * Extract the raw CID (+ optional path) from an IPFS URI.
 * Handles Foundation's double-prefix bug: `ipfs://ipfs/QmXXX`.
 *
 * Returns `null` if the URI is not an IPFS URI.
 */
export function extractCid(uri: string): string | null {
  if (!uri.startsWith("ipfs://")) return null
  let cid = uri.replace("ipfs://", "")
  // Fix Foundation's double-prefix bug: ipfs://ipfs/Qm...
  if (cid.startsWith("ipfs/")) cid = cid.replace("ipfs/", "")
  return cid || null
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
 * Convert an IPFS URI to an HTTP gateway URL.
 * Non-IPFS URIs are returned as-is.
 */
export function ipfsToHttp(uri: string, gateway?: string): string {
  const cid = extractCid(uri)
  if (!cid) return uri
  return ipfsToGatewayUrl(cid, gateway ?? DEFAULT_GATEWAY)
}

/**
 * Fetch content from IPFS, trying multiple gateways in sequence.
 * Returns the first successful Response, or throws if all fail.
 */
export async function fetchFromIpfs(
  cid: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 8_000

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

      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (res.ok) return res
    } catch {
      // Try next gateway
    }
  }

  throw new Error(`Failed to fetch IPFS content for CID: ${cid}`)
}
