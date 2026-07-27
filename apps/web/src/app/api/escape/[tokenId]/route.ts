/**
 * Serves one "escape (blue)" token's document, assembled offchain from the
 * artist's own contracts (see lib/escape-render.ts for why the work's own
 * tokenURI cannot be read over RPC).
 *
 * Served as a page rather than inlined as a data URI in the metadata: the
 * document runs to megabytes in fully-onchain mode, and the iframe that shows
 * it streams a URL far better than it parses a base64 blob. Sandboxed with the
 * same posture as the other artwork surfaces, plus autoplay so the work's
 * sound can start.
 */

import { buildEscapeArtwork } from "@/lib/escape-render"

type Params = { params: Promise<{ tokenId: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { tokenId } = await params
  if (!/^\d+$/.test(tokenId)) {
    return new Response("Bad token id.", { status: 400 })
  }
  const art = await buildEscapeArtwork(BigInt(tokenId))
  if (!art) return new Response("Could not assemble this token.", { status: 502 })

  return new Response(art.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "sandbox allow-scripts",
      "permissions-policy": "autoplay=*",
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    },
  })
}
