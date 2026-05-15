import "server-only"
import type { Address } from "viem"
import { sql } from "./db"
import { manifoldAdapter } from "./platforms/manifold"
import { superrareV2Adapter } from "./platforms/superrareV2"
import { transientAdapter } from "./platforms/transient"
import { isKnownArtist } from "./known-artists"

// Re-export so consumers can import `isKnownArtist` from this module
// alongside the refresh helpers. The implementation lives in
// `known-artists.ts` to avoid circular imports with the adapters
// (adapters need the gate; this module imports the adapters).
export { isKnownArtist }

/**
 * External-platform indexer: orchestrates writes to the per-platform
 * artist-token tables for Manifold, SuperRare V2, and Transient Labs.
 *
 * Background
 * ----------
 * These three platforms aren't in Ponder. The web app fetches per-artist
 * data from Alchemy NFT API / Alchemy Transfers / Etherscan on demand
 * and writes it to Postgres (`lazy_<platform>_artist_tokens` tables —
 * the "lazy" prefix is legacy naming from when they had TTLs). This
 * module:
 *
 *   1. Enforces the known-artist gate (`isKnownArtist`) so anonymous
 *      crawler traffic can't trigger Alchemy spend on random addresses.
 *   2. Drives the daily cron-based refresh of every known artist.
 *
 * Cost model
 * ----------
 * Reads: free (Postgres SELECT on indexed `creator`).
 * Writes (per artist per platform): ~150–1500 Alchemy CU.
 * Cron: daily refresh of every `known_artists` row × 3 platforms.
 *   At 100–2000 known artists: ~$0.07–$5/month bounded total.
 *
 * Membership: see db/migrations/022_known_artists_view.sql.
 *
 * Cache vs store
 * --------------
 * The per-platform tables are store, not cache. The adapter's
 * `discoverArtistTokens` trusts whatever rows exist for an artist —
 * no TTL gate. Refreshes happen via this module's `refreshArtist`,
 * which deletes the artist's status row so the adapter sees a cache
 * miss and re-fetches. Brief window between delete and re-fetch
 * during which a concurrent read returns `[]`; acceptable for the
 * off-peak cron timing.
 */

export type RefreshReport = {
  total: number
  succeeded: number
  failed: number
  durationMs: number
}

/**
 * Refresh external-platform indexes for every known artist. Designed
 * for `/api/cron/refresh-external-indexes`. Artists processed serially
 * to bound peak concurrency on Alchemy / Etherscan rate limits; each
 * artist's three platform refreshes run in parallel.
 */
export async function refreshAllKnownArtists(): Promise<RefreshReport> {
  const start = Date.now()
  if (!sql) {
    return { total: 0, succeeded: 0, failed: 0, durationMs: 0 }
  }
  const rows = (await sql`
    SELECT address FROM known_artists
  `) as Array<{ address: string }>

  let succeeded = 0
  let failed = 0
  for (const { address } of rows) {
    try {
      await refreshArtist(address)
      succeeded++
    } catch {
      failed++
    }
  }
  return {
    total: rows.length,
    succeeded,
    failed,
    durationMs: Date.now() - start,
  }
}

/**
 * Default freshness threshold for on-visit refresh checks. 1 hour means
 * an artist visiting their `/catalog` page within an hour of any prior
 * visit gets the cached state without re-fetching. Past 1h, a fresh
 * refresh fires in the background. Same threshold used for `/artist/`.
 */
const STALE_THRESHOLD_MS = 60 * 60 * 1000

/**
 * On-visit trigger: if the address is in `known_artists` AND any of its
 * platform status rows are older than `thresholdMs` (default 1h), run
 * `refreshArtist`. Designed to be invoked from within a Next.js
 * `after()` callback so the work survives serverless function teardown.
 *
 * Callers should always wrap this in `after()` (or `unstable_after()`)
 * at the page level — do NOT call as `void maybeRefreshArtistIfStale()`,
 * because Netlify tears down the function as soon as the response is
 * sent and any in-flight awaits get cut off. Example:
 *
 *     import { after } from "next/server"
 *     after(() => maybeRefreshArtistIfStale(address))
 *
 * Crawlers hitting pages for unknown addresses cost zero (the
 * `isKnownArtist` gate fires first); for known addresses they may
 * trigger one refresh per `thresholdMs` window per artist, but cost
 * stays bounded by the known-artists set.
 *
 * Race: two concurrent visits within the same window may both fire a
 * refresh. The wasted call is one per concurrent visitor — acceptable
 * at the volumes we expect.
 */
export async function maybeRefreshArtistIfStale(
  address: string,
  thresholdMs: number = STALE_THRESHOLD_MS,
): Promise<void> {
  if (!sql) return
  const lower = address.toLowerCase()

  // Gate first — unknown addresses cost nothing past this point.
  if (!(await isKnownArtist(lower))) return

  // Look at the oldest status row across all three platforms. If any is
  // stale (or any is missing entirely), refresh. Missing rows are
  // treated as "infinitely stale" → first-ever visit triggers a refresh.
  type Row = { oldest: string | null; missing: number }
  const rows = (await sql`
    WITH s AS (
      SELECT last_indexed_at FROM lazy_manifold_artist_status WHERE creator = ${lower}
      UNION ALL
      SELECT last_indexed_at FROM lazy_srv2_artist_status WHERE creator = ${lower}
      UNION ALL
      SELECT last_indexed_at FROM lazy_tl_artist_status WHERE creator = ${lower}
    )
    SELECT MIN(last_indexed_at)::text AS oldest, (3 - COUNT(*))::int AS missing
    FROM s
  `) as Row[]

  const row = rows[0]
  const missing = row?.missing ?? 3
  const oldest = row?.oldest ? new Date(row.oldest).getTime() : 0
  const stale =
    missing > 0 || Date.now() - oldest > thresholdMs

  if (!stale) return

  try {
    await refreshArtist(lower)
  } catch {
    // Swallow — best-effort background work; the cron picks up
    // anything we miss.
  }
}

/**
 * Refresh one artist across all three external platforms. Steps:
 *
 *   1. DELETE the artist's status row from each lazy_* status table
 *      so the adapter's cache check sees "never indexed" on next call.
 *   2. Call each adapter's `discoverArtistTokens(artist)` which:
 *      - sees the cache miss
 *      - gates on `isKnownArtist` (true, since we got here from a
 *        known-artists iteration or a known-artist on-demand caller)
 *      - fetches from Alchemy/Etherscan
 *      - writes fresh rows (updates `last_indexed_at` along the way)
 *
 * Per-platform failures are isolated (`catch(() => {})`) so one
 * platform's flakiness doesn't drop the others.
 */
export async function refreshArtist(address: string): Promise<void> {
  if (!sql) return
  const lower = address.toLowerCase() as Address

  // Invalidate status so the adapters' cache checks miss.
  await sql`
    DELETE FROM lazy_manifold_artist_status WHERE creator = ${lower}
  `
  await sql`
    DELETE FROM lazy_srv2_artist_status WHERE creator = ${lower}
  `
  await sql`
    DELETE FROM lazy_tl_artist_status WHERE creator = ${lower}
  `

  await Promise.all([
    superrareV2Adapter.discoverArtistTokens(lower).catch(() => undefined),
    transientAdapter.discoverArtistTokens(lower).catch(() => undefined),
    manifoldAdapter.discoverArtistTokens(lower).catch(() => undefined),
  ])
}
