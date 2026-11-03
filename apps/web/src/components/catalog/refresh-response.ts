/**
 * Maps a `/api/refresh-artist/[address]` response to RefreshButton's
 * state. Pure (no React, no fetch) so the plain-Node test runner can
 * cover it.
 *
 * The route is a thin enqueue proxy to the worker; it never waits for
 * the scan, so success carries no counts or durations:
 *   202 { ok: true, enqueued: true }   job accepted
 *   202 { ok: true, enqueued: false }  a job for this artist is already
 *                                      queued or running (worker dedup)
 *   403 { ok: false, error }           not a known artist
 *   503 { ok: false, error }           worker unreachable
 *   429 { ok: false, error, retryAfter? }  rate limited (kept for when a
 *                                      cooldown is added server-side)
 *
 * The old client expected `{ durationMs, totals, added, caughtUp }` and
 * read `added.manifold` off the 202, which threw at render (#297).
 */
export type RefreshState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "queued"; alreadyQueued: boolean }
  | { kind: "rate-limited"; retryAfterSec: number }
  | { kind: "error"; message: string }

const DEFAULT_RETRY_AFTER_SEC = 300

export function refreshStateFromResponse(status: number, body: unknown): RefreshState {
  const json = (body && typeof body === "object" ? body : {}) as {
    ok?: unknown
    enqueued?: unknown
    error?: unknown
    retryAfter?: unknown
  }
  const error = typeof json.error === "string" && json.error ? json.error : null

  if (status === 429) {
    const retry = Number(json.retryAfter)
    return {
      kind: "rate-limited",
      retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : DEFAULT_RETRY_AFTER_SEC,
    }
  }
  if (status >= 200 && status < 300 && json.ok === true) {
    return { kind: "queued", alreadyQueued: json.enqueued === false }
  }
  return { kind: "error", message: error ?? "Refresh failed" }
}
