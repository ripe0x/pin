/**
 * Wraps an image URL with the weserv.nl image proxy to serve a resized
 * WebP variant. Cuts grid-tile bytes by ~95% vs. raw IPFS originals.
 *
 * Only proxies known public IPFS gateway URLs — `data:` URLs, on-chain
 * SVG renderers, video files, and unfamiliar hosts pass through unchanged.
 * If weserv ever fails for a given image, `useOptimizedImage` falls back
 * to the raw gateway URL.
 */

import { isVideoUrl } from "./media-url"

const PROXYABLE_HOST_SUFFIXES = [
  "nftstorage.link",
  "dweb.link",
  "ipfs.io",
  "w3s.link",
  "cloudflare-ipfs.com",
  "arweave.net",
  "euc.li",
]

export function optimizeImageUrl(src: string, width = 800): string {
  if (!src.startsWith("http")) return src
  if (isVideoUrl(src)) return src
  let u: URL
  try {
    u = new URL(src)
  } catch {
    return src
  }
  const proxyable = PROXYABLE_HOST_SUFFIXES.some((h) => u.hostname.endsWith(h))
  if (!proxyable) return src
  const target = `${u.hostname}${u.pathname}${u.search}`
  return `https://images.weserv.nl/?url=${encodeURIComponent(target)}&w=${width}&output=webp&q=80&we=1`
}
