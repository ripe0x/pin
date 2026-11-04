// No "server-only" guard: SQL strings + pure decisions, so the plain-Node
// test runner (and the PGlite check) can import it. The DB-touching
// wrappers live in refresh-jobs.ts.

/**
 * Web side of the durable refresh queue (`refresh_jobs`, migration 035;
 * the worker side is apps/worker/src/refresh-queue.ts, which owns the
 * claim / retry / reclaim state machine).
 *
 * The web only ever:
 *   - reads the latest job for a target (status + cooldown),
 *   - INSERTs a 'queued' row when the cooldown allows it (ON CONFLICT DO
 *     NOTHING against the one-active-job index, so a racing duplicate
 *     click can't create a second job),
 *   - marks a finished artist job as having evicted the gallery cache.
 */

export type RefreshJobKind = "artist" | "token"
export type RefreshJobStatus = "queued" | "running" | "done" | "failed"

export type RefreshJob = {
  id: string
  kind: RefreshJobKind
  target: string
  status: RefreshJobStatus
  attempts: number
  maxAttempts: number
  enqueuedAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Seconds since finished_at (DB clock), null while active. */
  finishedAgeSeconds: number | null
  lastError: string | null
  result: unknown
  cacheInvalidated: boolean
}

export type RefreshJobRow = {
  id: string | number
  kind: RefreshJobKind
  target: string
  status: RefreshJobStatus
  attempts: number
  max_attempts: number
  enqueued_at: Date | string
  started_at: Date | string | null
  finished_at: Date | string | null
  finished_age_seconds: number | string | null
  last_error: string | null
  result: unknown
  cache_invalidated_at: Date | string | null
}

const JOB_COLUMNS = `id::text AS id, kind, target, status, attempts, max_attempts,
       enqueued_at, started_at, finished_at,
       EXTRACT(EPOCH FROM (NOW() - finished_at))::int AS finished_age_seconds,
       last_error, result, cache_invalidated_at`

/** $1 kind, $2 target. The newest job for the target, active or not. */
export const LATEST_JOB_SQL =
  `SELECT ${JOB_COLUMNS}
     FROM refresh_jobs
    WHERE kind = $1 AND target = $2
    ORDER BY id DESC
    LIMIT 1`

/**
 * $1 kind, $2 target. Same statement as the worker's ENQUEUE_SQL: returns
 * the new job, or no row when one is already queued or running.
 */
export const ENQUEUE_SQL =
  `INSERT INTO refresh_jobs (kind, target) VALUES ($1, $2)
   ON CONFLICT (kind, target) WHERE status IN ('queued', 'running') DO NOTHING
   RETURNING ${JOB_COLUMNS}`

/** $1 id. First observer of a finished job records the cache eviction. */
export const MARK_CACHE_INVALIDATED_SQL =
  `UPDATE refresh_jobs SET cache_invalidated_at = NOW()
    WHERE id = $1::bigint AND finished_at IS NOT NULL AND cache_invalidated_at IS NULL
   RETURNING id::text AS id`

function iso(v: Date | string | null): string | null {
  if (v == null) return null
  return (v instanceof Date ? v : new Date(v)).toISOString()
}

export function jobFromRow(row: RefreshJobRow): RefreshJob {
  const age = row.finished_age_seconds
  return {
    id: String(row.id),
    kind: row.kind,
    target: row.target,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    enqueuedAt: iso(row.enqueued_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    finishedAgeSeconds: age == null ? null : Number(age),
    lastError: row.last_error,
    result: row.result ?? null,
    cacheInvalidated: row.cache_invalidated_at != null,
  }
}

// ─── Cooldown ────────────────────────────────────────────────────────────

export const DEFAULT_ARTIST_COOLDOWN_MINUTES = 10
export const DEFAULT_TOKEN_COOLDOWN_MINUTES = 2

export function cooldownMinutes(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export type CooldownDecision =
  | { allow: true }
  | { allow: false; reason: "active" | "cooldown"; retryAfter: number; job: RefreshJob }

/**
 * Whether a new refresh may be enqueued, given the target's latest job.
 * Refused while a job is queued/running (the existing job is the answer;
 * the caller can poll it) or for `cooldownSeconds` after the last one
 * finished, done or failed. `retryAfter` is in seconds.
 */
export function cooldownDecision(
  latest: RefreshJob | null,
  cooldownSeconds: number,
): CooldownDecision {
  if (!latest) return { allow: true }
  if (latest.status === "queued" || latest.status === "running") {
    return {
      allow: false,
      reason: "active",
      retryAfter: Math.max(1, Math.ceil(cooldownSeconds)),
      job: latest,
    }
  }
  const age = latest.finishedAgeSeconds
  if (age != null && age < cooldownSeconds) {
    return {
      allow: false,
      reason: "cooldown",
      retryAfter: Math.max(1, Math.ceil(cooldownSeconds - age)),
      job: latest,
    }
  }
  return { allow: true }
}

// ─── Public shape ────────────────────────────────────────────────────────

export type PublicRefreshJob = {
  id: string
  status: RefreshJobStatus
  attempts: number
  maxAttempts: number
  enqueuedAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Artist jobs: tokens added by this run and the artist's total after it. */
  added: number | null
  total: number | null
  /** Artist jobs: sources whose scan failed in an otherwise finished run. */
  failedSources: string[]
  error: string | null
}

/** What the status API returns: no internal fields, error only on failure. */
export function publicJob(job: RefreshJob): PublicRefreshJob {
  const result = (job.result && typeof job.result === "object" ? job.result : {}) as {
    added?: unknown
    total?: unknown
    failedSources?: unknown
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  return {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    enqueuedAt: job.enqueuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    added: num(result.added),
    total: num(result.total),
    failedSources: Array.isArray(result.failedSources)
      ? result.failedSources.filter((s): s is string => typeof s === "string")
      : [],
    error: job.status === "failed" ? job.lastError : null,
  }
}

/** A finished artist job whose new tokens the cached gallery hasn't seen. */
export function needsCacheInvalidation(job: RefreshJob): boolean {
  return job.kind === "artist" && job.status === "done" && !job.cacheInvalidated
}
