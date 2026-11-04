/**
 * Per-scope failure backoff (audit M2, M3, M5; #295).
 *
 * scan-range.ts makes sure a failing range is never recorded as scanned,
 * but on its own that means a range that fails deterministically (a
 * provider result-size limit on a busy contract, a token whose mint
 * can't be found, an artist whose onboarding keeps failing) is retried
 * on every tick, forever, burning RPC and holding the task's per-tick
 * budget hostage. Here each failing scope is remembered in
 * `scan_backoff` (migration 031) and skipped for an exponentially
 * growing time:
 *
 *   failure n  ->  retry no sooner than  min(maxMs, baseMs * 2^n)
 *
 * With `baseMs` = the task's interval, the first failure skips about one
 * tick, the second about three, and so on. A scope that is retried and fails again
 * is never failing on consecutive ticks, so one poisoned scope doesn't
 * trip the per-task health check (task-health.ts), while each retry
 * still surfaces in TaskResult.errors. A success deletes the row.
 *
 * Takes the postgres client as an argument (no db.ts import) so the pure
 * pieces are unit-testable without DATABASE_URL.
 */

export type BackoffSql = {
  unsafe: (query: string, params?: string[]) => PromiseLike<unknown>
}

export type BackoffRow = {
  scope: string
  failures: number
  retryAt: Date
  lastError: string | null
}

export type BackoffPolicy = {
  /** Delay after the first failure is `baseMs * 2`. */
  baseMs: number
  /** Cap on the delay. */
  maxMs: number
}

const MAX_ERROR_CHARS = 1_000

export function backoffDelayMs(failures: number, policy: BackoffPolicy): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0
  // 2^n overflows to Infinity long before it matters; min() handles it.
  const delay = policy.baseMs * 2 ** Math.min(failures, 40)
  return Math.min(policy.maxMs, delay)
}

export function isBackedOff(row: BackoffRow | undefined, now: Date): boolean {
  return row !== undefined && row.retryAt.getTime() > now.getTime()
}

/** The row a failure leaves behind, given the previous one (if any). */
export function nextBackoff(
  prev: BackoffRow | undefined,
  scope: string,
  error: string,
  now: Date,
  policy: BackoffPolicy,
): BackoffRow {
  const failures = (prev?.failures ?? 0) + 1
  return {
    scope,
    failures,
    retryAt: new Date(now.getTime() + backoffDelayMs(failures, policy)),
    lastError: error.length > MAX_ERROR_CHARS ? `${error.slice(0, MAX_ERROR_CHARS - 1)}…` : error,
  }
}

type RawRow = { scope: string; failures: number; retry_at: Date | string; last_error: string | null }

function toRow(r: RawRow): BackoffRow {
  return {
    scope: r.scope,
    failures: Number(r.failures),
    retryAt: r.retry_at instanceof Date ? r.retry_at : new Date(r.retry_at),
    lastError: r.last_error,
  }
}

/** Every backoff row for a task, keyed by scope. One query per tick. */
export async function loadBackoff(sql: BackoffSql, task: string): Promise<Map<string, BackoffRow>> {
  const rows = (await sql.unsafe(
    "SELECT scope, failures, retry_at, last_error FROM scan_backoff WHERE task = $1",
    [task],
  )) as RawRow[]
  return new Map(rows.map((r) => [r.scope, toRow(r)]))
}

/**
 * Record a failure for one scope and return the new row. Callers hold
 * the previous row (from loadBackoff); tasks are single-flight, so the
 * read-modify-write doesn't race another writer of the same task.
 */
export async function recordFailure(
  sql: BackoffSql,
  task: string,
  prev: BackoffRow | undefined,
  scope: string,
  error: string,
  policy: BackoffPolicy,
  now: Date = new Date(),
): Promise<BackoffRow> {
  const row = nextBackoff(prev, scope, error, now, policy)
  await sql.unsafe(
    `INSERT INTO scan_backoff (task, scope, failures, retry_at, last_error, first_failed_at, updated_at)
     VALUES ($1, $2, $3::int, $4::timestamptz, $5, NOW(), NOW())
     ON CONFLICT (task, scope) DO UPDATE SET
       failures = EXCLUDED.failures,
       retry_at = EXCLUDED.retry_at,
       last_error = EXCLUDED.last_error,
       updated_at = NOW()`,
    [task, scope, String(row.failures), row.retryAt.toISOString(), row.lastError ?? ""],
  )
  return row
}

/** Forget a scope's failures after it succeeds. No-op without a row. */
export async function clearBackoff(sql: BackoffSql, task: string, scopes: string[]): Promise<void> {
  if (scopes.length === 0) return
  await sql.unsafe(
    "DELETE FROM scan_backoff WHERE task = $1 AND scope = ANY($2::text[])",
    [task, toPgTextArray(scopes)],
  )
}

/** Postgres text[] literal, for passing an array through string params. */
export function toPgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`
}

/**
 * Bundle handed to the shared scanners (transfer-from-zero,
 * erc1155-mints): the task's backoff rows plus its policy. Omitted for
 * on-demand refresh-artist runs, which always try.
 */
export type BackoffContext = {
  rows: Map<string, BackoffRow>
  policy: BackoffPolicy
  now?: Date
}

/**
 * Shared bookkeeping around one scope's scan: skip it while backed off,
 * record a failure, clear on success. Returns whether the scope was
 * skipped and, on failure, the error message to surface.
 */
export async function withBackoff<T extends { error: string | null }>(
  sql: BackoffSql,
  task: string,
  scope: string,
  ctx: BackoffContext | undefined,
  run: () => Promise<T>,
): Promise<T | { skipped: true }> {
  const now = ctx?.now ?? new Date()
  const prev = ctx?.rows.get(scope)
  if (ctx && isBackedOff(prev, now)) return { skipped: true }
  const result = await run()
  if (!ctx) return result
  if (result.error) {
    await recordFailure(sql, task, prev, scope, result.error, ctx.policy, now).catch((err) => {
      console.error(`[worker.backoff] ${task} ${scope}: could not record failure:`, err)
    })
  } else if (prev) {
    await clearBackoff(sql, task, [scope]).catch((err) => {
      console.error(`[worker.backoff] ${task} ${scope}: could not clear backoff:`, err)
    })
  }
  return result
}
