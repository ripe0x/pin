/**
 * Retention rules for prune-retention (tasks/prune-retention.ts). Pure
 * data + env parsing so the SQL is reviewable and unit-tested in one
 * place. Every DELETE picks its victims through an index-backed
 * subquery with a LIMIT, so a backlog drains over a few bounded
 * statements per run instead of one long-locking one.
 */

export const DEFAULT_ITERATION_RETENTION_DAYS = 30

export function retentionDays(env: string | undefined): number {
  const n = Number(env)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ITERATION_RETENTION_DAYS
}

export type RetentionStep = {
  name: string
  /** Skip the step when this relation doesn't exist (to_regclass). */
  requiresTable?: string
  sql: string
  /** Positional params for `sql`, given the iteration retention days. */
  params: (iterationDays: number) => string[]
  batchSize: number
  maxBatches: number
}

export const RETENTION_STEPS: RetentionStep[] = [
  {
    // Same rule as apps/web/src/lib/pg-cache.ts pgCacheCleanup(1):
    // expired for more than a day. Reads never return expired rows.
    name: "cache_entries",
    sql:
      "DELETE FROM cache_entries WHERE key IN (" +
      "SELECT key FROM cache_entries WHERE expires_at < NOW() - interval '1 day' " +
      "ORDER BY expires_at LIMIT $1::int)",
    params: () => [],
    batchSize: 5_000,
    maxBatches: 20,
  },
  {
    name: "worker_iterations",
    sql:
      "DELETE FROM worker_iterations WHERE id IN (" +
      "SELECT id FROM worker_iterations " +
      "WHERE started_at < NOW() - ($2::int * interval '1 day') " +
      "ORDER BY started_at LIMIT $1::int)",
    params: (days) => [String(days)],
    batchSize: 10_000,
    maxBatches: 10,
  },
  {
    // Fixed windows from the web rate limiter (#369, migration 029). The
    // web app also prunes opportunistically; this covers quiet periods.
    name: "rate_limits",
    requiresTable: "public.rate_limits",
    sql:
      "DELETE FROM rate_limits WHERE key IN (" +
      "SELECT key FROM rate_limits WHERE window_start < NOW() - interval '1 day' " +
      "ORDER BY window_start LIMIT $1::int)",
    params: () => [],
    batchSize: 5_000,
    maxBatches: 20,
  },
  {
    name: "scan_backoff",
    requiresTable: "public.scan_backoff",
    sql:
      "DELETE FROM scan_backoff WHERE (task, scope) IN (" +
      "SELECT task, scope FROM scan_backoff WHERE updated_at < NOW() - interval '30 days' " +
      "ORDER BY updated_at LIMIT $1::int)",
    params: () => [],
    batchSize: 5_000,
    maxBatches: 4,
  },
  {
    // Finished on-demand refresh jobs (#297, migration 035). Active jobs
    // have no finished_at and are never touched.
    name: "refresh_jobs",
    requiresTable: "public.refresh_jobs",
    sql:
      "DELETE FROM refresh_jobs WHERE id IN (" +
      "SELECT id FROM refresh_jobs WHERE finished_at < NOW() - interval '30 days' " +
      "ORDER BY finished_at LIMIT $1::int)",
    params: () => [],
    batchSize: 5_000,
    maxBatches: 4,
  },
]
