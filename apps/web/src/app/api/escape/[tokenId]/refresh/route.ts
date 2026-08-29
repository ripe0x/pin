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
 * costs a ~65M gas read, so this cannot be a free button to mash.
 */

import { timingSafeEqual } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { pgCache, pgCacheHas, pgCacheInvalidate } from "@/lib/pg-cache"

type Params = { params: Promise<{ tokenId: string }> }

const COOLDOWN_SECONDS = 300

export async function POST(req: NextRequest, { params }: Params) {
  const expected = process.env.REVALIDATE_SECRET
  if (!expected) {
    return NextResponse.json({ error: "Refresh is unavailable." }, { status: 503 })
  }
  const authorization = req.headers.get("authorization")
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : ""
  if (!secretMatches(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const { tokenId } = await params
  if (!/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: "Bad token id." }, { status: 400 })
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

function secretMatches(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided)
  const expectedBytes = Buffer.from(expected)
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  )
}
