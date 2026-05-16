import "server-only"
import { sql } from "./db"
import { scanSrv2ArtistTokens } from "./platforms/superrareV2"
import { scanManifoldArtistTokens } from "./manifold-discovery"
import { isKnownArtist } from "./known-artists"

// Re-export so consumers can import `isKnownArtist` from this module
// alongside the refresh helpers.
export { isKnownArtist }

/**
 * Maximum chain blocks any single scan call will cover, end-to-end.
 *
 * Sized to fit comfortably within Netlify's 26-second HTTP-function
 * timeout. Three platforms scan in parallel via Promise.all; the slowest
 * platform's serial `paginatedIndexedScan` (2M block per getLogs call,
 * ~2-3s per call against drpc + Alchemy) dictates wall time. At 10M
 * blocks that's 5 sequential getLogs per platform ≈ 10-15s total — well
 * inside the timeout with margin for the surrounding DB work.
 *
 * On a fresh-cursor artist (full chain history needed), one refresh
 * call advances each cursor by ~10M blocks. SR V2 (8M → 25M = 17M
 * blocks) needs ~2 refreshes to catch up; Manifold (~13M blocks) ~2;
 * TL (~6M blocks) fits in one. Cron over multiple days catches up
 * eventually without user interaction.
 *
 * Bigger numbers risk timeout; smaller numbers make catch-up take more
 * refresh clicks. 10M is the current safe operating point.
 */
export const MAX_BLOCKS_PER_SCAN = 10_000_000n

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
 * doesn't drop the others. A failed scan is treated as
 * `caughtUp: false` so the caller knows further refresh attempts may
 * surface more data.
 *
 * No DELETE of status rows: incremental scans depend on the existing
 * `last_scanned_block`, so we only update on success.
 *
 * Returns `{ caughtUp }` — true only when ALL three platforms scanned
 * up to chain head this call. False when at least one platform stopped
 * short due to the `MAX_BLOCKS_PER_SCAN` budget or due to a thrown
 * error. Callers (the refresh-button route, the cron) use this to
 * decide whether the artist needs more refresh cycles.
 */
export async function refreshArtist(
  address: string,
): Promise<{ caughtUp: boolean }> {
  if (!sql) return { caughtUp: true }
  const lower = address.toLowerCase() as `0x${string}`

  const results = await Promise.all([
    scanSrv2ArtistTokens(lower).catch(() => ({ caughtUp: false })),
    scanManifoldArtistTokens(lower).catch(() => ({ caughtUp: false })),
  ])
  return { caughtUp: results.every((r) => r.caughtUp) }
}

/**
 * Returns true iff at least one platform's `last_scanned_block` is
 * null for this artist — i.e., they've never been scanned. Used by
 * the refresh-button route to bypass the 5-min cooldown for artists
 * who are mid-catch-up.
 *
 * Limitation: once every cursor is non-null, this returns false even
 * if the cursor is far behind head. The trade-off keeps the check
 * RPC-free (no chain-head lookup) and bounds cooldown bypass to the
 * first scan only. Catch-up beyond the first scan happens via the
 * daily cron, which doesn't enforce per-artist cooldown.
 */
export async function hasUnscannedPlatform(
  address: string,
): Promise<boolean> {
  if (!sql) return false
  const lower = address.toLowerCase()
  try {
    const rows = (await sql`
      SELECT
        (SELECT last_scanned_block FROM lazy_manifold_artist_status WHERE creator = ${lower}) AS m,
        (SELECT last_scanned_block FROM lazy_srv2_artist_status     WHERE creator = ${lower}) AS s
    `) as Array<{
      m: string | null
      s: string | null
    }>
    const r = rows[0]
    // Mint and TL are no longer in this list — Ponder owns their indexes,
    // so there's no per-artist "first scan" pass to catch up on.
    return r.m === null || r.s === null
  } catch {
    return false
  }
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
  mint: number
}

export async function countArtistTokens(
  address: string,
): Promise<ArtistTokenCounts> {
  if (!sql) return { manifold: 0, srv2: 0, tl: 0, mint: 0 }
  const lower = address.toLowerCase()
  // Mint and TL counts come from Ponder; Manifold + SR V2 still live in
  // public.lazy_*_artist_tokens until those platforms migrate too.
  // Sanitize INDEXER_SCHEMA the same way indexer-queries.ts does.
  const indexerSchema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
    /[^a-zA-Z0-9_]/g,
    "",
  )
  try {
    const rows = (await sql.unsafe(
      `SELECT
        (SELECT COUNT(*) FROM lazy_manifold_artist_tokens WHERE creator = $1)::int AS manifold,
        (SELECT COUNT(*) FROM lazy_srv2_artist_tokens     WHERE creator = $1)::int AS srv2,
        (SELECT COUNT(*) FROM ${indexerSchema}.tl_artist_tokens   WHERE creator = $1)::int AS tl,
        (SELECT COUNT(*) FROM ${indexerSchema}.mint_artist_tokens WHERE creator = $1)::int AS mint`,
      [lower],
    )) as unknown as Array<{
      manifold: number
      srv2: number
      tl: number
      mint: number
    }>
    const r = rows[0]
    return {
      manifold: r?.manifold ?? 0,
      srv2: r?.srv2 ?? 0,
      tl: r?.tl ?? 0,
      mint: r?.mint ?? 0,
    }
  } catch {
    return { manifold: 0, srv2: 0, tl: 0, mint: 0 }
  }
}
