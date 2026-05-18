/**
 * Maintain the `known_artists` materialized view, plus any explicit
 * manual seeds from `artist_seeds`. The view itself is defined in
 * migration 012; this task is the heartbeat that keeps the materialized
 * version current (if we ever switch from a plain VIEW to a MATERIALIZED
 * VIEW for performance — currently a plain VIEW, so this task is a
 * no-op in steady state and just records its iteration for audit).
 *
 * On the day we switch to a materialized view: change the body to
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY known_artists`.
 */
import { sql } from "../db.ts"
import type { TaskResult } from "../scheduler.ts"

export async function seedKnownArtists(): Promise<TaskResult> {
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM known_artists`) as Array<{ n: number }>
  const n = rows[0]?.n ?? 0
  return { scopeCount: n, rpcCalls: 0, rowsWritten: 0 }
}
