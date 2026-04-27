import { revalidateTag } from "next/cache"
import { NextRequest, NextResponse } from "next/server"

/**
 * Manually flush the artist gallery + enriched-page caches. Hit this after
 * minting a new token so the gallery picks it up immediately instead of
 * waiting for the 24h TTL.
 *
 * Usage:
 *   curl 'https://pnd.ripe.wtf/api/revalidate?secret=$REVALIDATE_SECRET'
 *
 * Both `artist-refs` and `artist-enriched` are global tags — flushing
 * invalidates the caches for ALL artists, not just one. Repopulation is
 * lazy (one cold gallery read per artist), so the cost is bounded; the
 * tradeoff is a slightly slower next page-load for everyone after a flush.
 *
 * The optional `artist` query param is informational (echoed in the
 * response) — actual revalidation is always global because `unstable_cache`
 * tags are static at definition time.
 */
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret")
  const expected = process.env.REVALIDATE_SECRET

  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "REVALIDATE_SECRET env var not set on server" },
      { status: 500 },
    )
  }
  if (secret !== expected) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    )
  }

  revalidateTag("artist-refs")
  revalidateTag("artist-enriched")

  const artist = req.nextUrl.searchParams.get("artist")
  return NextResponse.json({
    ok: true,
    revalidated: ["artist-refs", "artist-enriched"],
    requested_for: artist ?? null,
    note: "All-artist flush; per-artist tagging requires dynamic tags (not supported by unstable_cache).",
  })
}
