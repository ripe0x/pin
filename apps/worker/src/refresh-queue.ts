/**
 * Durable on-demand refresh queue (#297), backed by `refresh_jobs`
 * (migration 035). Replaces the in-memory Set queues the scheduler used,
 * which dropped every accepted job on a restart.
 *
 * Life of a job:
 *
 *   queued ──claim──▶ running ──ok──▶ done
 *     ▲                 │
 *     │   attempts <    ├──error / timeout──▶ queued (run_after = now + backoff)
 *     │   max_attempts  │
 *     └─────────────────┤   attempts >= max_attempts ──▶ failed
 *                       │
 *                       └──heartbeat older than the lease (crash)──▶ same rule,
 *                                                                    retried now
 *
 * - The web (apps/web/src/lib/refresh-jobs.ts) and this worker's legacy
 *   POST /jobs/* endpoint both enqueue with ENQUEUE_SQL: one active
 *   (queued or running) job per (kind, target), enforced by a partial
 *   unique index, so duplicate clicks are no-ops.
 * - Claims use FOR UPDATE SKIP LOCKED, so two worker replicas never run
 *   the same job.
 * - `attempts` doubles as a fencing token: heartbeat / complete / fail
 *   only touch the row while it still carries the attempt number this
 *   runner claimed, so a runner whose lease was reclaimed can't
 *   overwrite the newer attempt's state.
 *
 * Pure decision helpers + SQL strings are exported for tests; the
 * executors take a minimal `sql.unsafe` so tests don't need a database.
 */

export type RefreshJobKind = "artist" | "token"
export type RefreshJobStatus = "queued" | "running" | "done" | "failed"

export type RefreshQueueSql = {
  unsafe: (query: string, params?: Array<string | number>) => PromiseLike<unknown>
}

export type ClaimedJob = {
  id: string
  kind: RefreshJobKind
  target: string
  /** Attempt number of this claim (1-based); the fencing token. */
  attempts: number
  maxAttempts: number
}

// ─── Policy ──────────────────────────────────────────────────────────────

/** A running job whose heartbeat is older than this is reclaimed. */
export const DEFAULT_LEASE_SECONDS = 300
/** Heartbeat cadence while a job runs; well inside the lease. */
export const HEARTBEAT_MS = 60_000
export const RETRY_BASE_SECONDS = 30
export const RETRY_MAX_SECONDS = 30 * 60
/** Hard cap on one attempt; past it the attempt is recorded as failed. */
export const DEFAULT_JOB_TIMEOUT_MS: Record<RefreshJobKind, number> = {
  artist: 30 * 60_000,
  token: 2 * 60_000,
}

export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * Delay before retrying after the `attempts`-th failed attempt: 30s, 2m,
 * 8m, ... capped at 30 min.
 */
export function retryDelaySeconds(
  attempts: number,
  baseSeconds = RETRY_BASE_SECONDS,
  maxSeconds = RETRY_MAX_SECONDS,
): number {
  if (attempts < 1) return 0
  const exp = Math.min(attempts - 1, 20)
  return Math.min(maxSeconds, baseSeconds * 4 ** exp)
}

export type FailureDecision =
  | { status: "queued"; runAfter: Date }
  | { status: "failed"; finishedAt: Date }

/**
 * What a failed attempt (error, timeout, or an expired lease) turns the
 * job into. Mirrors the CASE in FAIL_SQL / RECLAIM_SQL.
 */
export function afterFailure(
  job: { attempts: number; maxAttempts: number },
  now: Date,
  delaySeconds = retryDelaySeconds(job.attempts),
): FailureDecision {
  if (job.attempts >= job.maxAttempts) return { status: "failed", finishedAt: now }
  return { status: "queued", runAfter: new Date(now.getTime() + delaySeconds * 1000) }
}

export function isLeaseExpired(
  heartbeatAt: Date | null,
  now: Date,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): boolean {
  if (!heartbeatAt) return true
  return now.getTime() - heartbeatAt.getTime() > leaseSeconds * 1000
}

/** Whether a queued job may be claimed now. */
export function isClaimable(
  job: { status: RefreshJobStatus; runAfter: Date },
  now: Date,
): boolean {
  return job.status === "queued" && job.runAfter.getTime() <= now.getTime()
}

const MAX_ERROR_CHARS = 1_000

export function truncateError(message: string): string {
  return message.length > MAX_ERROR_CHARS
    ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…`
    : message
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const TOKEN_ID_RE = /^[0-9]+$/

export function artistTarget(address: string): string | null {
  const lower = address.toLowerCase()
  return ADDRESS_RE.test(lower) ? lower : null
}

export function tokenTarget(contract: string, tokenId: string): string | null {
  const c = contract.toLowerCase()
  return ADDRESS_RE.test(c) && TOKEN_ID_RE.test(tokenId) ? `${c}:${tokenId}` : null
}

export function parseTokenTarget(target: string): { contract: string; tokenId: string } {
  const sep = target.lastIndexOf(":")
  return { contract: target.slice(0, sep), tokenId: target.slice(sep + 1) }
}

// ─── SQL ─────────────────────────────────────────────────────────────────

/** $1 kind, $2 target. Returns the new row's id, or nothing if a job is active. */
export const ENQUEUE_SQL =
  `INSERT INTO refresh_jobs (kind, target) VALUES ($1, $2)
   ON CONFLICT (kind, target) WHERE status IN ('queued', 'running') DO NOTHING
   RETURNING id::text AS id`

/** $1 kind. Claims the oldest due queued job of that kind. */
export const CLAIM_SQL =
  `UPDATE refresh_jobs
      SET status = 'running', attempts = attempts + 1,
          started_at = NOW(), heartbeat_at = NOW()
    WHERE id = (
      SELECT id FROM refresh_jobs
       WHERE kind = $1 AND status = 'queued' AND run_after <= NOW()
       ORDER BY run_after, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
   RETURNING id::text AS id, kind, target, attempts, max_attempts`

/** $1 id, $2 attempts (fence). */
export const HEARTBEAT_SQL =
  `UPDATE refresh_jobs SET heartbeat_at = NOW()
    WHERE id = $1::bigint AND status = 'running' AND attempts = $2::int`

/** $1 id, $2 attempts (fence), $3 result JSON text. */
export const COMPLETE_SQL =
  `UPDATE refresh_jobs
      SET status = 'done', finished_at = NOW(), heartbeat_at = NULL,
          result = $3::jsonb
    WHERE id = $1::bigint AND status = 'running' AND attempts = $2::int
   RETURNING id::text AS id`

/**
 * $1 id, $2 attempts (fence), $3 error, $4 retry delay seconds. Retries
 * while attempts < max_attempts, else terminal 'failed'.
 */
export const FAIL_SQL =
  `UPDATE refresh_jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          finished_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END,
          run_after = NOW() + ($4::int * interval '1 second'),
          heartbeat_at = NULL,
          last_error = $3
    WHERE id = $1::bigint AND status = 'running' AND attempts = $2::int
   RETURNING status`

/**
 * $1 lease seconds. A running job whose heartbeat stopped (the worker
 * crashed or restarted mid-run) counts as a failed attempt and is retried
 * immediately, or failed for good once out of attempts.
 */
export const RECLAIM_SQL =
  `UPDATE refresh_jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          finished_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END,
          run_after = NOW(),
          heartbeat_at = NULL,
          last_error = 'lease expired: worker stopped while running this job'
    WHERE status = 'running'
      AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - ($1::int * interval '1 second'))
   RETURNING id::text AS id, status`

/**
 * $1 id, $2 attempts (fence). Graceful shutdown: hand a running job back
 * without spending an attempt.
 */
export const RELEASE_SQL =
  `UPDATE refresh_jobs
      SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
          run_after = NOW(), heartbeat_at = NULL
    WHERE id = $1::bigint AND status = 'running' AND attempts = $2::int`

/** /metrics summary: active jobs plus the last day's terminal ones. */
export const QUEUE_STATS_SQL =
  `SELECT kind, status, count(*)::int AS jobs, min(enqueued_at) AS oldest_enqueued_at
     FROM refresh_jobs
    WHERE status IN ('queued', 'running') OR finished_at > NOW() - interval '24 hours'
    GROUP BY kind, status
    ORDER BY kind, status`

// ─── Executors ───────────────────────────────────────────────────────────

export async function enqueueRefreshJob(
  sql: RefreshQueueSql,
  kind: RefreshJobKind,
  target: string,
): Promise<boolean> {
  const rows = (await sql.unsafe(ENQUEUE_SQL, [kind, target])) as Array<{ id: string }>
  return rows.length > 0
}

export async function claimRefreshJob(
  sql: RefreshQueueSql,
  kind: RefreshJobKind,
): Promise<ClaimedJob | null> {
  const rows = (await sql.unsafe(CLAIM_SQL, [kind])) as Array<{
    id: string
    kind: RefreshJobKind
    target: string
    attempts: number
    max_attempts: number
  }>
  const r = rows[0]
  if (!r) return null
  return {
    id: String(r.id),
    kind: r.kind,
    target: r.target,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  }
}

export async function reclaimExpiredJobs(
  sql: RefreshQueueSql,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<Array<{ id: string; status: RefreshJobStatus }>> {
  return (await sql.unsafe(RECLAIM_SQL, [leaseSeconds])) as Array<{
    id: string
    status: RefreshJobStatus
  }>
}

export async function releaseRefreshJob(sql: RefreshQueueSql, job: ClaimedJob): Promise<void> {
  await sql.unsafe(RELEASE_SQL, [job.id, job.attempts])
}

export type RunOptions = {
  timeoutMs: number
  heartbeatMs?: number
  /** Override retry delays (tests). */
  retryDelaySeconds?: (attempts: number) => number
}

export type RunOutcome =
  | { kind: "idle" }
  | { kind: "done"; job: ClaimedJob; result: unknown }
  | { kind: "retry" | "failed"; job: ClaimedJob; error: string }
  /** The lease was reclaimed mid-run; a newer attempt owns the job. */
  | { kind: "lost"; job: ClaimedJob }

export class JobTimeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`)
    this.name = "JobTimeout"
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeout(ms)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** Claim one due job of `kind` and run it (tests and simple callers). */
export async function runNextRefreshJob(
  sql: RefreshQueueSql,
  kind: RefreshJobKind,
  handler: (target: string) => Promise<unknown>,
  opts: RunOptions,
): Promise<RunOutcome> {
  const job = await claimRefreshJob(sql, kind)
  if (!job) return { kind: "idle" }
  return runClaimedRefreshJob(sql, job, handler, opts)
}

/**
 * Run an already-claimed job with `handler(target)`, heartbeating while
 * it runs. The handler's resolved value is stored as the job's `result`;
 * a throw (or the timeout) is a failed attempt. On timeout the handler's
 * promise is abandoned, not cancelled; refresh scans are idempotent.
 */
export async function runClaimedRefreshJob(
  sql: RefreshQueueSql,
  job: ClaimedJob,
  handler: (target: string) => Promise<unknown>,
  opts: RunOptions,
): Promise<Exclude<RunOutcome, { kind: "idle" }>> {
  const heartbeat = setInterval(() => {
    void Promise.resolve(sql.unsafe(HEARTBEAT_SQL, [job.id, job.attempts])).catch((err) => {
      console.error(`[refresh-queue] heartbeat ${job.id}:`, err)
    })
  }, opts.heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref?.()

  try {
    let result: unknown
    try {
      result = await withTimeout(handler(job.target), opts.timeoutMs)
    } catch (err) {
      const error = truncateError(err instanceof Error ? err.message : String(err))
      const delay = (opts.retryDelaySeconds ?? retryDelaySeconds)(job.attempts)
      const rows = (await sql.unsafe(FAIL_SQL, [job.id, job.attempts, error, delay])) as Array<{
        status: RefreshJobStatus
      }>
      if (rows.length === 0) return { kind: "lost", job }
      return { kind: rows[0].status === "failed" ? "failed" : "retry", job, error }
    }
    const done = (await sql.unsafe(COMPLETE_SQL, [
      job.id, job.attempts, JSON.stringify(result ?? null),
    ])) as unknown[]
    // No row: the lease was reclaimed while this attempt ran; the newer
    // attempt owns the job now.
    if (done.length === 0) return { kind: "lost", job }
    return { kind: "done", job, result }
  } finally {
    clearInterval(heartbeat)
  }
}
