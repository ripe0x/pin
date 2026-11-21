/**
 * Drops one "escape (blue)" token's cached document so the next view
 * reassembles it from the contracts.
 *
 * The assembled document is cached for a day (see lib/escape-render.ts). A
 * holder flipping their token's mode does not need this: the mode is part of
 * the cache key, so that change shows immediately. This is for the owner-side
 * edits that do not move the key, such as setImage or bgColor.
 *
 * Rate limited to once every five minutes per token, following the same
 * server-enforces-the-limit convention as the token refresh button: a rebuild
 * costs a ~65M gas read, so this cannot be a free button to mash. Only a
 * token the escape route would serve (lib/escape-resolve.ts) can be
 * refreshed, and a per-IP limit sits in front of the per-token one.
 */

import { NextResponse } from "next/server"
import { pgCache, pgCacheHas, pgCacheInvalidate } from "@/lib/pg-cache"
import { isEscapeRenderer } from "@/lib/escape-render"
import { resolveEscapeTarget } from "@/lib/escape-resolve"
import { collectionTokenExists, getCollection } from "@/lib/collection-onchain"
import { ESCAPE_BLUE_DESCRIPTOR } from "@/lib/launch-descriptors"
import { rateLimitResponse } from "@/lib/rate-limit"

type Params = { params: Promise<{ tokenId: string }> }

const COOLDOWN_SECONDS = 300

const DEFAULT_COLLECTION =
  process.env.ESCAPE_COLLECTION_ADDRESS ?? ESCAPE_BLUE_DESCRIPTOR.deployedAddress ?? null

export async function POST(req: Request, { params }: Params) {
  const limited = await rateLimitResponse(req, {
    namespace: "escape-refresh",
    windowMs: 60_000,
    max: 10,
  })
  if (limited) return limited

  const { tokenId } = await params
  if (!/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: "Bad token id." }, { status: 400 })
  }

  const target = await resolveEscapeTarget(
    {
      tokenId,
      collection: new URL(req.url).searchParams.get("collection"),
      renderer: null,
    },
    {
      defaultCollection: DEFAULT_COLLECTION,
      getCollection: (address) => getCollection(address).catch(() => null),
      isEscapeRenderer: (renderer) => isEscapeRenderer(renderer).catch(() => false),
      tokenExists: (collection, id) => collectionTokenExists(collection, id),
    },
  )
  if (!target) {
    return NextResponse.json({ error: "Unknown token." }, { status: 404 })
  }

  const cooldownKey = `escape-refresh:${tokenId}`
  if (await pgCacheHas(cooldownKey)) {
    return NextResponse.json(
      { error: "This token was refreshed recently. Try again in a few minutes." },
      { status: 429 },
    )
  }
  await pgCache(cooldownKey, COOLDOWN_SECONDS, async () => "1")
  // Key is escape-art:v2:<tokenId>:<renderer>:<mode>; this drops every
  // renderer/mode variant for exactly this token.
  await pgCacheInvalidate(`escape-art:v2:${tokenId}:`)

  return NextResponse.json({ refreshed: true, tokenId })
}
