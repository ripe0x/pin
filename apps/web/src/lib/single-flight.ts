/**
 * Single-flight: collapse concurrent identical work onto one in-flight call.
 *
 * Problem this solves: when a token URL gets shared and many users click
 * within a few seconds, every server render fires the same expensive
 * `getArtistGalleryPage(...)` BEFORE any of them populates the cache —
 * Nx the work for one piece of data.
 *
 * Approach: an in-process `Map<key, Promise>`. The first caller for a key
 * starts `fn()` and stores its promise; concurrent callers for the same
 * key await that same promise instead of starting their own. When it
 * settles (resolve or reject) the entry is cleared so the next call runs
 * fresh. Net effect: a burst of N concurrent same-key callers becomes 1
 * execution + N-1 awaiters.
 *
 * Why in-memory (not a Postgres lock):
 *   The previous implementation used a `single_flight_locks` table with a
 *   poll-and-wait loop. That table isn't part of the v2 schema, so every
 *   call failed to acquire, burned the full `waitMs` polling, and churned
 *   pool connections with failing INSERTs before falling through — adding
 *   ~3s of latency to every gallery request and tipping a small serverless
 *   pool into connection-exhaustion failures. An in-process map needs no
 *   DB, no table, and no network round-trip.
 *
 * Scope note: dedup is per-process. On serverless (one pool per instance)
 * a key is deduped within an instance but not across instances. That's
 * acceptable here — the wrapped `fn` is itself `unstable_cache`-backed and
 * ISR/CDN absorbs the bulk of fan-out, so cross-instance stampede is rare
 * and self-limits. On a long-running process (one instance) dedup is total.
 *
 * `options` (waitMs / lockTtlMs) are retained for call-site compatibility
 * and ignored — the map-based approach has no wait or TTL to tune.
 */

type Options = {
  /** Retained for call-site compatibility; ignored. */
  waitMs?: number
  /** Retained for call-site compatibility; ignored. */
  lockTtlMs?: number
}

const inFlight = new Map<string, Promise<unknown>>()

export async function withSingleFlight<T>(
  key: string,
  fn: () => Promise<T>,
  _options: Options = {},
): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined
  if (existing) return existing

  const promise = fn()
  inFlight.set(key, promise)
  try {
    return await promise
  } finally {
    // Clear once settled so the next call re-runs (and re-checks the
    // wrapped cache) rather than reusing a stale resolved promise.
    inFlight.delete(key)
  }
}
