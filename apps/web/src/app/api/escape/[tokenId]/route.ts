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
 *
 * `?collection=0x…` names the collection (the launch collection when
 * omitted). The renderer is always the one that collection points at, and
 * only an indexed PND collection whose renderer has the escape shape is
 * served (lib/escape-resolve.ts); everything else is a 404.
 */

import { type Address } from "viem"
import { buildEscapeArtwork, isEscapeRenderer } from "@/lib/escape-render"
import { ESCAPE_DOCUMENT_CSP, resolveEscapeTarget } from "@/lib/escape-resolve"
import { collectionTokenExists, getCollection } from "@/lib/collection-onchain"
import { ESCAPE_BLUE_DESCRIPTOR } from "@/lib/launch-descriptors"
import { rateLimit } from "@/lib/rate-limit"

type Params = { params: Promise<{ tokenId: string }> }

/** The launch collection, used when the caller names none. */
const DEFAULT_COLLECTION =
  process.env.ESCAPE_COLLECTION_ADDRESS ?? ESCAPE_BLUE_DESCRIPTOR.deployedAddress ?? null

function notFound() {
  return new Response("Not found.", {
    status: 404,
    headers: { "cache-control": "public, max-age=60, s-maxage=300" },
  })
}

export async function GET(req: Request, { params }: Params) {
  const rl = await rateLimit(req, { namespace: "escape", windowMs: 60_000, max: 120 })
  if (!rl.ok) {
    return new Response("Too many requests.", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    })
  }

  const { tokenId } = await params
  const search = new URL(req.url).searchParams
  const target = await resolveEscapeTarget(
    {
      tokenId,
      collection: search.get("collection"),
      renderer: search.get("renderer"),
    },
    {
      defaultCollection: DEFAULT_COLLECTION,
      getCollection: (address) => getCollection(address).catch(() => null),
      isEscapeRenderer: (renderer) => isEscapeRenderer(renderer).catch(() => false),
      tokenExists: (collection, id) => collectionTokenExists(collection, id),
    },
  )
  if (!target) return notFound()

  const art = await buildEscapeArtwork(target.renderer as Address, target.tokenId)
  if (!art) return new Response("Could not assemble this token.", { status: 502 })

  return new Response(art.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": ESCAPE_DOCUMENT_CSP,
      "permissions-policy": "autoplay=*",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    },
  })
}
