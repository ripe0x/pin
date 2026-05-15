import { NextRequest, NextResponse } from "next/server"
import { refreshAllKnownArtists } from "@/lib/external-indexer"

/**
 * Daily refresh of external-platform indexes (Manifold, SuperRare V2,
 * Transient Labs) for every artist in the `known_artists` view.
 *
 * Each artist's three platform indexes get refreshed serially per
 * artist (parallel within an artist). For each artist's platform:
 *
 *   1. Delete the artist's row from `lazy_<platform>_artist_status`.
 *   2. Call the platform adapter's `discoverArtistTokens(artist)`,
 *      which sees the cache miss, calls Alchemy/Etherscan, writes
 *      fresh rows to `lazy_<platform>_artist_tokens`.
 *
 * Cost: ~150–1500 Alchemy CU per artist per platform = ~$0.0002/artist.
 * At 100–2000 known artists × 3 platforms: $0.06–$5/month bounded.
 *
 * Auth: shares `REVALIDATE_SECRET` with the rest of /api/cron/*.
 * Schedule example (external cron / Netlify scheduled function):
 *
 *   curl -X POST 'https://pnd.ripe.wtf/api/cron/refresh-external-indexes?secret=$REVALIDATE_SECRET'
 *
 * Recommended cadence: once daily during off-peak hours
 * (e.g. 04:00 UTC). The serial loop means a 2000-artist run may take
 * several minutes; ensure the cron host's timeout is generous.
 */

// Vercel serverless function timeout — bumped from the default 10s
// because the serial loop over known artists can take minutes.
export const maxDuration = 300

export async function POST(req: NextRequest) {
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

  const report = await refreshAllKnownArtists()
  return NextResponse.json({ ok: true, ...report })
}
