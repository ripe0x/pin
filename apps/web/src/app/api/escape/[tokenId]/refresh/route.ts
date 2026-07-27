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

import { NextResponse } from "next/server"
import { pgCache, pgCacheHas, pgCacheInvalidate } from "@/lib/pg-cache"

type Params = { params: Promise<{ tokenId: string }> }

const COOLDOWN_SECONDS = 300

export async function POST(_req: Request, { params }: Params) {
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
  await pgCacheInvalidate(`escape-art:${tokenId}:`)

  return NextResponse.json({ refreshed: true, tokenId })
}
