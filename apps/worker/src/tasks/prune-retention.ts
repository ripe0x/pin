/**
 * Retention pruning for the shared Postgres (#351 phase 0, web audit M3).
 *
 *   - cache_entries: the web app's TTL cache (apps/web/src/lib/pg-cache.ts).
 *     Expired rows are never read (reads filter `expires_at > NOW()`) but
 *     nothing deleted them: pgCacheCleanup() had no caller, and keys come
 *     from unbounded inputs, some MB-sized. Same rule as pgCacheCleanup
 *     (expired for more than a day), deleted in bounded batches through
 *     the expires_at index so one run never holds a long lock.
 *   - worker_iterations: the worker's audit log, kept
 *     WORKER_ITERATIONS_RETENTION_DAYS (default 30). This replaces the
 *     prune that #342 put inline in the scheduler after every task run
 *     (same 30-day rule), so the rule lives in one place and runs on a
 *     schedule instead of piggybacking on whichever task finished.
 *   - rate_limits: the web rate limiter's fixed windows (#369, migration
 *     029). Windows older than a day are dead. Guarded with to_regclass,
 *     so this runs fine before 029 is applied.
 *   - scan_backoff: rows untouched for 30 days (a scope that stopped being
 *     scanned; an active failing scope is updated at least daily).
 *
 * Each step is independent: one failing doesn't skip the others, and its
 * error is surfaced in TaskResult.errors.
 */
import { sql } from "../db.ts"
import type { TaskResult } from "../scheduler.ts"
import { retentionDays, RETENTION_STEPS, type RetentionStep } from "../retention.ts"

export async function pruneRetention(): Promise<TaskResult> {
  const days = retentionDays(process.env.WORKER_ITERATIONS_RETENTION_DAYS)
  let rowsWritten = 0
  const errors: string[] = []

  for (const step of RETENTION_STEPS) {
    try {
      const deleted = await runStep(step, days)
      rowsWritten += deleted
      if (deleted > 0) console.log(`[prune-retention] ${step.name}: deleted ${deleted} row(s)`)
    } catch (err) {
      console.error(`[prune-retention] ${step.name}:`, err)
      errors.push(`${step.name}: ${(err as Error).message}`)
    }
  }
  return { scopeCount: RETENTION_STEPS.length, rpcCalls: 0, rowsWritten, errors }
}

async function runStep(step: RetentionStep, iterationDays: number): Promise<number> {
  if (step.requiresTable) {
    const rows = (await sql.unsafe(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [step.requiresTable],
    )) as Array<{ present: boolean }>
    if (!rows[0]?.present) return 0
  }
  let total = 0
  for (let i = 0; i < step.maxBatches; i++) {
    const result = await sql.unsafe(step.sql, [String(step.batchSize), ...step.params(iterationDays)])
    total += result.count
    if (result.count < step.batchSize) break
  }
  return total
}
