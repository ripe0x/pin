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

import { isAddress, type Address } from "viem"
import { buildEscapeArtwork } from "@/lib/escape-render"

type Params = { params: Promise<{ tokenId: string }> }

/** Which renderer instance to assemble from. The artist redeploys the same
 *  contract per release, so the caller names the one its collection points
 *  at; the hint address stands in when nothing is passed. */
const HINT = (process.env.ESCAPE_RENDERER_ADDRESS ??
  "0x538ffA56d568Dfb373Baf15d099E610b4a9a00D5") as Address

export async function GET(req: Request, { params }: Params) {
  const { tokenId } = await params
  const asked = new URL(req.url).searchParams.get("renderer")
  const renderer = asked && isAddress(asked) ? (asked as Address) : HINT
  if (!/^\d+$/.test(tokenId)) {
    return new Response("Bad token id.", { status: 400 })
  }
  const art = await buildEscapeArtwork(renderer, BigInt(tokenId))
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
