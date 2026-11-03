/**
 * Standalone chrome-free live view: serves the token's assembled HTML
 * document directly, so a live render has a shareable, embeddable URL
 * (our equivalent of a generator URL). The document comes from the same
 * cached tokenURI read the token page makes — no extra RPC class.
 *
 * The CSP sandbox header is load-bearing: the artist's document executes
 * with a unique opaque origin (like a sandboxed iframe), never with this
 * site's origin, so token code can't touch anything of ours.
 *
 * This is the canonical onchain document (decoded straight from tokenURI),
 * so it stays the right target for a shareable URL. It is the same document
 * the token page's Live mode reconstructs client-side via the parity
 * renderer (byte-identical by construction) — this route just serves the
 * source of truth directly instead of rebuilding it.
 *
 * Only PND collections are served: an address outside the indexed
 * collection set is a 404 before any token read. A non-inline
 * animation_url redirects only to a known IPFS / Arweave gateway
 * (lib/live-redirect.ts); anything else is a 404.
 */

import { notFound, redirect } from "next/navigation"
import { isAddress, type Address } from "viem"
import { getCollection, getCollectionToken } from "@/lib/collection-onchain"
import { liveRedirectTarget } from "@/lib/live-redirect"

const HTML_DATA_PREFIX = "data:text/html;base64,"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string; tokenId: string }> },
) {
  const { address, tokenId: tokenIdStr } = await params
  if (!isAddress(address)) notFound()
  if (!/^\d{1,78}$/.test(tokenIdStr)) notFound()
  const tokenId = BigInt(tokenIdStr)

  // Membership gate first: an arbitrary contract is never read or served.
  const collection = await getCollection(address as Address).catch(() => null)
  if (!collection) notFound()

  const t = await getCollectionToken(address as Address, tokenId)
  if (!t || !t.animationUrl) notFound()

  if (t.animationUrl.startsWith(HTML_DATA_PREFIX)) {
    const html = Buffer.from(t.animationUrl.slice(HTML_DATA_PREFIX.length), "base64")
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
        // Let a work with sound start audio (still gesture-gated); the CSP
        // sandbox gives this document an opaque origin, so grant autoplay
        // explicitly rather than relying on the default self-origin allowlist.
        "permissions-policy": "autoplay=*",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    })
  }

  // This site's own assembled-document route (escape tokens) stays on-site.
  if (t.animationUrl.startsWith("/api/escape/")) redirect(t.animationUrl)

  // Non-data animation URLs redirect to their gateway, when it is a known one.
  const target = liveRedirectTarget(t.animationUrl)
  if (!target) notFound()
  redirect(target)
}
