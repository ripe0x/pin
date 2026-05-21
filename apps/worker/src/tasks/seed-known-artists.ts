/**
 * Heartbeat for the `known_artists` view + one-shot onboarding for
 * newly-discovered artists.
 *
 * The view itself is defined in migration 011 (refresh on the day we
 * switch to a materialized version). This task is also responsible for
 * detecting artists who have JUST joined the set and firing a one-shot
 * Path B (mints-to-artist) scan for them — the scheduled scan-manifold
 * task no longer runs Path B on every tick to avoid the per-artist
 * Alchemy polling cost.
 *
 * Marker for "Path B has been run for this artist": a row in
 * worker_cursors with task='scan-manifold' and scope='$artist:mints-to'.
 * On first ever Path B run for an artist the cursor row is created;
 * subsequent runs UPDATE it. So missing-cursor = never-run = newly-known.
 *
 * Cap enqueued artists per tick so a sudden burst (e.g. operator adds
 * 50 manual seeds at once) doesn't overrun the worker's refresh queue.
 */
import { sql } from "../db.ts"
import { enqueueRefreshArtist, type TaskResult } from "../scheduler.ts"

const ONBOARD_PER_TICK = 5

export async function seedKnownArtists(): Promise<TaskResult> {
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM known_artists`) as Array<{ n: number }>
  const n = rows[0]?.n ?? 0

  // Find artists in known_artists who have NEVER had a Path B run.
  // The `:mints-to` cursor is created by discoverMintsToArtist on its
  // first successful invocation; its absence is the "not yet onboarded"
  // signal.
  const newArtists = (await sql`
    SELECT k.address
    FROM known_artists k
    LEFT JOIN worker_cursors c
      ON c.task = 'scan-manifold' AND c.scope = (k.address || ':mints-to')
    WHERE c.scope IS NULL
    LIMIT ${ONBOARD_PER_TICK}
  `) as Array<{ address: string }>

  let enqueued = 0
  for (const r of newArtists) {
    if (enqueueRefreshArtist(r.address)) enqueued++
  }
  if (enqueued > 0) {
    console.log(`[seed-known-artists] enqueued ${enqueued} new artist(s) for first-time Path B scan`)
  }

  return { scopeCount: n, rpcCalls: 0, rowsWritten: enqueued }
}
