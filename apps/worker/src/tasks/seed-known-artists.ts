/**
 * Heartbeat for the `known_artists` view + one-shot onboarding for
 * newly-discovered artists.
 *
 * This task detects artists who have JUST joined the set and fires a
 * one-shot Path B (mints-to-artist) scan for them via the refresh-artist
 * queue — the scheduled scan-manifold task no longer runs Path B on
 * every tick to avoid the per-artist Alchemy polling cost.
 *
 * Marker for "Path B has been run for this artist": a row in
 * worker_cursors with task='scan-manifold' and scope='$artist:mints-to'.
 * Missing-cursor = never-run = not yet onboarded.
 *
 * Onboarding is capped per tick so a sudden burst (e.g. operator adds
 * 50 manual seeds at once) doesn't overrun the refresh queue. The cap
 * used to take `LIMIT 5` with no ordering, and the marker is only
 * written when Path B succeeds (it returns null when ALCHEMY_API_KEY is
 * unset or Alchemy errors), so the same 5 failing artists were picked
 * every hour and nobody else was ever onboarded (audit M5, #295). Now:
 *
 *   - every enqueue is recorded as an attempt in scan_backoff (scope =
 *     the artist). An artist still missing the marker on a later tick has
 *     failed that attempt; it is retried after an exponentially growing
 *     delay (1h, 2h, 4h, ... capped at a day), and skipped meanwhile;
 *   - candidates are ordered deterministically: never-attempted artists
 *     first (by address), then attempted ones by fewest attempts and
 *     oldest first attempt. Five failing artists can't block the queue.
 *
 * Once an artist's marker exists its attempt row is cleared.
 */
import { sql } from "../db.ts"
import { enqueueRefreshArtist, type TaskResult } from "../scheduler.ts"
import { loadBackoff, recordFailure, type BackoffPolicy } from "../backoff.ts"

const ONBOARD_PER_TICK = 5
const TASK = "seed-known-artists"
// Interval is 60 min; first retry ~1h after the first attempt (the
// refresh needs time to run), then doubling, capped at a day.
const BACKOFF: BackoffPolicy = { baseMs: 30 * 60_000, maxMs: 24 * 60 * 60_000 }

export async function seedKnownArtists(): Promise<TaskResult> {
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM known_artists`) as Array<{ n: number }>
  const n = rows[0]?.n ?? 0

  // Artists who completed onboarding: drop their attempt rows.
  await sql`
    DELETE FROM scan_backoff b
    USING worker_cursors c
    WHERE b.task = ${TASK}
      AND c.task = 'scan-manifold' AND c.scope = (b.scope || ':mints-to')
  `

  // Artists in known_artists who have NEVER had a successful Path B run,
  // minus those waiting out a retry delay, in a stable order.
  const newArtists = (await sql`
    SELECT k.address
    FROM known_artists k
    LEFT JOIN worker_cursors c
      ON c.task = 'scan-manifold' AND c.scope = (k.address || ':mints-to')
    LEFT JOIN scan_backoff b
      ON b.task = ${TASK} AND b.scope = k.address
    WHERE c.scope IS NULL
      AND (b.retry_at IS NULL OR b.retry_at <= NOW())
    ORDER BY (b.scope IS NOT NULL), b.failures, b.first_failed_at, k.address
    LIMIT ${ONBOARD_PER_TICK}
  `) as Array<{ address: string }>

  const attempts = await loadBackoff(sql, TASK)
  let enqueued = 0
  const retried: string[] = []
  for (const r of newArtists) {
    if (!enqueueRefreshArtist(r.address)) continue // already queued / in flight
    enqueued++
    const prev = attempts.get(r.address)
    if (prev) retried.push(r.address)
    await recordFailure(
      sql, TASK, prev, r.address,
      prev ? `still not onboarded after ${prev.failures} attempt(s)` : "onboarding attempt",
      BACKOFF,
    ).catch((err) => console.error(`[${TASK}] record attempt ${r.address}:`, err))
  }
  if (enqueued > 0) {
    console.log(`[${TASK}] enqueued ${enqueued} new artist(s) for first-time Path B scan`)
  }
  if (retried.length > 0) {
    console.warn(`[${TASK}] retrying onboarding for ${retried.length} artist(s): ${retried.join(", ")}`)
  }

  return { scopeCount: n, rpcCalls: 0, rowsWritten: enqueued }
}
