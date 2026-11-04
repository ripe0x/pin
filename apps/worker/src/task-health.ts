/**
 * Per-task health evaluation for GET /health (audit M6, #295).
 *
 * The old check passed as long as ANY task finished in the last 30
 * minutes, so a task failing on every run, or a promise stuck in
 * `running` forever, never raised an alarm. Now every scheduled task is
 * judged on its own, and /health is non-200 if any of them is:
 *
 *   - failing:  the last `maxConsecutiveFailures` runs (default 3) all
 *               ended with ok = false (a throw, or TaskResult.errors).
 *   - stuck:    running for longer than its timeout.
 *   - stale:    not running, and no run finished (or was skipped
 *               waiting on Ponder) within 3x its interval. Measured from
 *               process start until the first run, so a fresh boot is
 *               healthy and the Railway deploy healthcheck passes.
 *
 * Skips caused by `dependsOnPonder` while the indexer isn't ready count
 * as alive (the task did its job: it checked and waited), and are
 * reported as `waiting-on-ponder` so the reason is visible.
 *
 * Pure module, unit-tested; scheduler.ts supplies the inputs.
 */

export type TaskHealthInput = {
  name: string
  intervalMs: number
  timeoutMs: number
  running: boolean
  runningSince: Date | null
  lastFinishedAt: Date | null
  lastOkAt: Date | null
  lastSkippedAt: Date | null
  consecutiveFailures: number
  lastError: string | null
}

export type TaskStatus = "ok" | "waiting-on-ponder" | "failing" | "stuck" | "stale"

export type TaskHealth = {
  status: TaskStatus
  healthy: boolean
  running: boolean
  runningForMs: number | null
  intervalMs: number
  timeoutMs: number
  lastFinishedAt: string | null
  lastOkAt: string | null
  consecutiveFailures: number
  lastError: string | null
}

export type HealthReport = {
  ok: boolean
  unhealthy: string[]
  tasks: Record<string, TaskHealth>
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3
export const STALE_INTERVALS = 3
const MIN_TIMEOUT_MS = 2 * 60 * 60_000
const TIMEOUT_INTERVALS = 6
const MAX_ERROR_CHARS = 300

/** Default per-task timeout: 6x the interval, at least 2 hours. */
export function defaultTaskTimeoutMs(intervalMs: number): number {
  return Math.max(MIN_TIMEOUT_MS, intervalMs * TIMEOUT_INTERVALS)
}

export function maxConsecutiveFailures(env: string | undefined): number {
  const n = Number(env)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONSECUTIVE_FAILURES
}

const iso = (d: Date | null) => d?.toISOString() ?? null

export function evaluateTaskHealth(
  t: TaskHealthInput,
  now: Date,
  bootAt: Date,
  opts: { maxConsecutiveFailures?: number } = {},
): TaskHealth {
  const maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
  const nowMs = now.getTime()
  const runningForMs = t.running && t.runningSince ? nowMs - t.runningSince.getTime() : null

  // Latest sign of life: a finished run, a Ponder-gated skip, or boot.
  const lastAlive = Math.max(
    t.lastFinishedAt?.getTime() ?? 0,
    t.lastSkippedAt?.getTime() ?? 0,
    bootAt.getTime(),
  )

  let status: TaskStatus
  if (runningForMs !== null && runningForMs > t.timeoutMs) {
    status = "stuck"
  } else if (t.consecutiveFailures >= maxFailures) {
    status = "failing"
  } else if (!t.running && nowMs - lastAlive > t.intervalMs * STALE_INTERVALS) {
    status = "stale"
  } else if (
    !t.running &&
    t.lastSkippedAt !== null &&
    (t.lastFinishedAt === null || t.lastSkippedAt > t.lastFinishedAt)
  ) {
    status = "waiting-on-ponder"
  } else {
    status = "ok"
  }

  const err = t.lastError
  return {
    status,
    healthy: status === "ok" || status === "waiting-on-ponder",
    running: t.running,
    runningForMs,
    intervalMs: t.intervalMs,
    timeoutMs: t.timeoutMs,
    lastFinishedAt: iso(t.lastFinishedAt),
    lastOkAt: iso(t.lastOkAt),
    consecutiveFailures: t.consecutiveFailures,
    lastError: err && err.length > MAX_ERROR_CHARS ? `${err.slice(0, MAX_ERROR_CHARS - 1)}…` : err,
  }
}

export function evaluateHealth(
  tasks: TaskHealthInput[],
  now: Date,
  bootAt: Date,
  opts: { maxConsecutiveFailures?: number } = {},
): HealthReport {
  const out: Record<string, TaskHealth> = {}
  const unhealthy: string[] = []
  for (const t of tasks) {
    const h = evaluateTaskHealth(t, now, bootAt, opts)
    out[t.name] = h
    if (!h.healthy) unhealthy.push(t.name)
  }
  return { ok: unhealthy.length === 0, unhealthy, tasks: out }
}
