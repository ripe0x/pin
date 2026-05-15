import "server-only"
import { sql } from "./db"
import { scanSrv2ArtistTokens } from "./platforms/superrareV2"
import { scanTransientArtistTokens } from "./platforms/transient"
import { scanManifoldArtistTokens } from "./manifold-discovery"
import { isKnownArtist } from "./known-artists"

// Re-export so consumers can import `isKnownArtist` from this module
// alongside the refresh helpers.
export { isKnownArtist }

/**
 * External-platform indexer: orchestrates writes to the per-platform
 * artist-token tables for Manifold, SuperRare V2, and Transient Labs.
 *
 * Background
 * ----------
 * These three platforms aren't in Ponder. The web app fetches per-artist
 * data from Alchemy + Etherscan on demand and writes it to Postgres
 * (`lazy_<platform>_artist_tokens` tables — the "lazy" prefix is legacy
 * from when they had TTLs). This module:
 *
 *   1. Enforces the known-artist gate (`isKnownArtist`) so anonymous
 *      crawler traffic can't trigger Alchemy spend on random addresses.
 *   2. Drives the daily cron-based refresh of every known artist
 *      (`refreshAllKnownArtists`).
 *   3. Provides `refreshArtist` for the manual "Refresh my work" button
 *      route (`/api/refresh-artist/[address]`) which is rate-limited at
 *      5 minutes per artist.
 *
 * Incremental scans
 * -----------------
 * Each refresh resumes from the per-artist `last_scanned_block` cursor
 * in `lazy_<platform>_artist_status`, so a typical refresh pays for only
 * a few hours of new chain history instead of full sweeps from the
 * platform's deploy block. See `db/migrations/023_per_artist_last_scanned_block.sql`.
 *
 * Cache vs store
 * --------------
 * The per-platform tables are store, not cache. The platform adapters'
 * `discoverArtistTokens` is pure-read — it trusts whatever rows exist
 * for an artist (no TTL gate) and never triggers external API calls.
 * The scan functions (`scanSrv2ArtistTokens`, `scanTransientArtistTokens`,
 * `scanManifoldArtistTokens`) are the only code that talks to
 * Alchemy/Etherscan, and they're called only from `refreshArtist`.
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
 * Refresh one artist across all three external platforms. The three
 * scan functions are independent and run in parallel; each gates on
 * `isKnownArtist` and is incremental against its own
 * `last_scanned_block` cursor.
 *
 * Per-platform failures are isolated so one platform's flakiness
 * doesn't drop the others.
 *
 * No DELETE of status rows: incremental scans depend on the existing
 * `last_scanned_block`, so we only update on success.
 */
export async function refreshArtist(address: string): Promise<void> {
  if (!sql) return
  const lower = address.toLowerCase() as `0x${string}`

  await Promise.all([
    scanSrv2ArtistTokens(lower).catch(() => undefined),
    scanTransientArtistTokens(lower).catch(() => undefined),
    scanManifoldArtistTokens(lower).catch(() => undefined),
  ])
}

/**
 * Most-recent `last_indexed_at` across the three platform status rows
 * for one artist. Used by `/api/refresh-artist/[address]` as the
 * rate-limit cursor — reject the button-click if any platform was
 * refreshed within the last cooldown window. Returns null if no
 * status rows exist (artist has never been refreshed).
 */
export async function getMostRecentRefreshTime(
  address: string,
): Promise<Date | null> {
  if (!sql) return null
  const lower = address.toLowerCase()
  try {
    const rows = (await sql`
      SELECT MAX(last_indexed_at)::text AS latest FROM (
        SELECT last_indexed_at FROM lazy_manifold_artist_status WHERE creator = ${lower}
        UNION ALL
        SELECT last_indexed_at FROM lazy_srv2_artist_status WHERE creator = ${lower}
        UNION ALL
        SELECT last_indexed_at FROM lazy_tl_artist_status WHERE creator = ${lower}
      ) s
    `) as Array<{ latest: string | null }>
    const latest = rows[0]?.latest
    return latest ? new Date(latest) : null
  } catch {
    return null
  }
}

/**
 * Token row counts per platform after a refresh, for the button's UI
 * feedback ("you have N Manifold tokens, M SR V2 tokens, ..."). Used
 * by `/api/refresh-artist/[address]` in the success response.
 */
export type ArtistTokenCounts = {
  manifold: number
  srv2: number
  tl: number
}

export async function countArtistTokens(
  address: string,
): Promise<ArtistTokenCounts> {
  if (!sql) return { manifold: 0, srv2: 0, tl: 0 }
  const lower = address.toLowerCase()
  try {
    const rows = (await sql`
      SELECT
        (SELECT COUNT(*) FROM lazy_manifold_artist_tokens WHERE creator = ${lower})::int AS manifold,
        (SELECT COUNT(*) FROM lazy_srv2_artist_tokens     WHERE creator = ${lower})::int AS srv2,
        (SELECT COUNT(*) FROM lazy_tl_artist_tokens       WHERE creator = ${lower})::int AS tl
    `) as Array<{ manifold: number; srv2: number; tl: number }>
    const r = rows[0]
    return {
      manifold: r?.manifold ?? 0,
      srv2: r?.srv2 ?? 0,
      tl: r?.tl ?? 0,
    }
  } catch {
    return { manifold: 0, srv2: 0, tl: 0 }
  }
}
