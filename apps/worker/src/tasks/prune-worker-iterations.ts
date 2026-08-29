import { sql } from "../db.ts"
import type { TaskResult } from "../scheduler.ts"

/** Keep detailed worker telemetry bounded while retaining daily cost history. */
export async function pruneWorkerIterations(): Promise<TaskResult> {
  await sql`
    INSERT INTO worker_daily_metrics
      (day, task, iterations, errors, scope_count, rpc_calls, rows_written,
       duration_ms, updated_at)
    SELECT started_at::date, task, COUNT(*), COUNT(*) FILTER (WHERE NOT ok),
           SUM(scope_count), SUM(rpc_calls), SUM(rows_written),
           COALESCE(SUM(
             EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000
           ), 0)::bigint, NOW()
    FROM worker_iterations
    WHERE started_at < CURRENT_DATE
    GROUP BY started_at::date, task
    ON CONFLICT (day, task) DO UPDATE SET
      iterations = EXCLUDED.iterations,
      errors = EXCLUDED.errors,
      scope_count = EXCLUDED.scope_count,
      rpc_calls = EXCLUDED.rpc_calls,
      rows_written = EXCLUDED.rows_written,
      duration_ms = EXCLUDED.duration_ms,
      updated_at = NOW()
  `

  const deletedIterations = await sql`
    DELETE FROM worker_iterations
    WHERE started_at < NOW() - INTERVAL '30 days'
  `
  // pgCache replaces values by key but does not otherwise revisit expired
  // keys. Production had accumulated tens of thousands of dead cache rows,
  // including large renderer payloads, so fold safe expiry cleanup into the
  // existing daily maintenance task.
  const deletedCacheEntries = await sql`
    DELETE FROM cache_entries
    WHERE expires_at < NOW()
  `
  return {
    scopeCount: 2,
    rpcCalls: 0,
    rowsWritten: deletedIterations.count + deletedCacheEntries.count,
  }
}
