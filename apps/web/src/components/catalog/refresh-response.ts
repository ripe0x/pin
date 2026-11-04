/**
 * Maps `/api/refresh-artist/[address]` responses to RefreshButton's
 * state, and decides how the button polls a job to a terminal state.
 * Pure (no React, no fetch) so the plain-Node test runner can cover it.
 *
 * The route enqueues a durable job (refresh_jobs, #297) and returns at
 * once; the worker runs it later. Contract:
 *   POST 202 { ok: true, enqueued: true, job }      job accepted
 *   POST 202 { ok: true, enqueued, job: null }      legacy fallback (no
 *                                                   job to poll)
 *   POST 429 { ok: false, reason: "active", retryAfter, job }
 *                                                   one is already queued
 *                                                   or running: poll it
 *   POST 429 { ok: false, reason: "cooldown" | -, retryAfter }
 *   POST 403 / 503 { ok: false, error }
 *   GET  200 { ok: true, job | null }               status poll
 *
 * The old client expected `{ durationMs, totals, added, caughtUp }` and
 * read `added.manifold` off the 202, which threw at render (#297).
 */
export type RefreshJobView = {
  id: string
  status: "queued" | "running" | "done" | "failed"
  added: number | null
  failedSources: string[]
  error: string | null
}

export type RefreshState =
  | { kind: "idle" }
  | { kind: "loading" }
  /** A job to follow; `alreadyQueued` when the click found one active. */
  | { kind: "job"; job: RefreshJobView; alreadyQueued: boolean; gaveUp?: boolean }
  /** Accepted without a pollable job (legacy fallback). */
  | { kind: "queued"; alreadyQueued: boolean }
  | { kind: "rate-limited"; retryAfterSec: number }
  | { kind: "error"; message: string }

const DEFAULT_RETRY_AFTER_SEC = 300
const STATUSES = new Set(["queued", "running", "done", "failed"])

/** Delays between status polls after a click: ~2 min in total. */
export const POLL_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000] as const

export function parseJob(raw: unknown): RefreshJobView | null {
  if (!raw || typeof raw !== "object") return null
  const j = raw as Record<string, unknown>
  if (typeof j.id !== "string" || typeof j.status !== "string" || !STATUSES.has(j.status)) {
    return null
  }
  return {
    id: j.id,
    status: j.status as RefreshJobView["status"],
    added: typeof j.added === "number" && Number.isFinite(j.added) ? j.added : null,
    failedSources: Array.isArray(j.failedSources)
      ? j.failedSources.filter((s): s is string => typeof s === "string")
      : [],
    error: typeof j.error === "string" && j.error ? j.error : null,
  }
}

export function isTerminal(job: RefreshJobView): boolean {
  return job.status === "done" || job.status === "failed"
}

export function refreshStateFromResponse(status: number, body: unknown): RefreshState {
  const json = (body && typeof body === "object" ? body : {}) as {
    ok?: unknown
    enqueued?: unknown
    error?: unknown
    retryAfter?: unknown
    reason?: unknown
    job?: unknown
  }
  const error = typeof json.error === "string" && json.error ? json.error : null
  const job = parseJob(json.job)

  if (status === 429) {
    if (json.reason === "active" && job) {
      return { kind: "job", job, alreadyQueued: true }
    }
    const retry = Number(json.retryAfter)
    return {
      kind: "rate-limited",
      retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : DEFAULT_RETRY_AFTER_SEC,
    }
  }
  if (status >= 200 && status < 300 && json.ok === true) {
    if (job) return { kind: "job", job, alreadyQueued: json.enqueued === false }
    return { kind: "queued", alreadyQueued: json.enqueued === false }
  }
  return { kind: "error", message: error ?? "Refresh failed" }
}

/**
 * Fold a GET status poll into the current state. Only a poll for the job
 * being followed counts; anything unreadable leaves the state alone (the
 * next poll retries).
 */
export function applyStatusPoll(state: RefreshState, status: number, body: unknown): RefreshState {
  if (state.kind !== "job" || status !== 200) return state
  const json = (body && typeof body === "object" ? body : {}) as { ok?: unknown; job?: unknown }
  if (json.ok !== true) return state
  const job = parseJob(json.job)
  if (!job || job.id !== state.job.id) return state
  return { ...state, job }
}

/** Whether to schedule poll number `pollIndex` (0-based) for `state`. */
export function shouldPoll(state: RefreshState, pollIndex: number): boolean {
  return state.kind === "job" && !isTerminal(state.job) && pollIndex < POLL_DELAYS_MS.length
}

export function describeJob(job: RefreshJobView, alreadyQueued = false): string {
  switch (job.status) {
    case "queued":
      return alreadyQueued ? "A refresh is already queued" : "Refresh queued"
    case "running":
      return "Refreshing your work…"
    case "failed":
      return job.error ? `Refresh failed: ${job.error}` : "Refresh failed"
    case "done": {
      const n = job.added
      const head =
        n == null ? "Refresh done"
          : n === 0 ? "Refresh done — no new pieces"
            : `Refresh done — ${n} new piece${n === 1 ? "" : "s"}`
      return job.failedSources.length > 0
        ? `${head} (some sources didn’t finish: ${job.failedSources.join(", ")})`
        : head
    }
  }
}
