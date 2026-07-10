/**
 * Standalone chrome-free live view: serves the token's assembled HTML
 * document directly, so a live render has a shareable, embeddable URL
 * (our equivalent of a generator URL). The document comes from the same
 * cached tokenURI read the token page makes — no extra RPC class.
 *
 * The CSP sandbox header is load-bearing: the artist's document executes
 * with a unique opaque origin (like a sandboxed iframe), never with this
 * site's origin, so token code can't touch anything of ours.
 */

import { notFound, redirect } from "next/navigation"
import { isAddress, type Address } from "viem"
import { getCollectionToken } from "@/lib/collection-onchain"
import { ipfsToHttp } from "@/lib/collection"

const HTML_DATA_PREFIX = "data:text/html;base64,"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string; tokenId: string }> },
) {
  const { address, tokenId: tokenIdStr } = await params
  if (!isAddress(address)) notFound()
  let tokenId: bigint
  try {
    tokenId = BigInt(tokenIdStr)
  } catch {
    notFound()
  }

  const t = await getCollectionToken(address as Address, tokenId!)
  if (!t || !t.animationUrl) notFound()

  if (t.animationUrl.startsWith(HTML_DATA_PREFIX)) {
    const html = Buffer.from(t.animationUrl.slice(HTML_DATA_PREFIX.length), "base64")
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "sandbox allow-scripts",
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    })
  }

  // Non-data animation URLs (ipfs/http) just redirect to their own host.
  redirect(ipfsToHttp(t.animationUrl))
}
