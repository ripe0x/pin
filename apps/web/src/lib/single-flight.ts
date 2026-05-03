/**
 * Single-flight: serialize concurrent expensive work on the same key.
 *
 * Problem this solves: when a token URL gets shared on Discord and 50
 * users click within 30 seconds, all 50 server-side renders fire the
 * same expensive `getArtistGalleryPage(...)` (or similar) BEFORE any
 * of them populates the cache. 50× the RPC for the same data.
 *
 * Approach: wrap the expensive call in `withSingleFlight(key, fn)`.
 * The first caller for a given key acquires a Postgres lock row and
 * runs `fn`. Concurrent callers for the same key wait for the lock
 * (poll up to `waitMs`), then re-enter `fn` — by which time the
 * cache wrapped inside `fn` will hit and return without doing the
 * expensive work. Net effect: stampede of N concurrent same-key
 * callers becomes 1 expensive call + N-1 cache hits.
 *
 * Why a custom table instead of `pg_advisory_lock`:
 *   Railway's Postgres uses PgBouncer-style pooling. In
 *   transaction-mode pooling, advisory locks acquired in one
 *   transaction don't persist for the next — silently breaking the
 *   pattern. The TTL-based table works under any pooling mode and
 *   self-heals if a holder crashes (lock expires, next acquirer
 *   reclaims it via the UPDATE branch of ON CONFLICT).
 *
 * Failure modes:
 *   - DB unavailable → fall through to running `fn` directly. Loses
 *     stampede protection but doesn't block the request.
 *   - Couldn't acquire lock within `waitMs` → run `fn` anyway.
 *     Better duplicate work than infinite blocking under sustained
 *     contention.
 *   - Lock holder crashes mid-fetch → lock expires after
 *     `lockTtlMs`, next acquirer takes over. Set the TTL above the
 *     longest legitimate single-flight body to avoid premature
 *     hand-off mid-render.
 */
import { sql } from "./db"
import { randomUUID } from "crypto"

const DEFAULT_WAIT_MS = 3_000
const DEFAULT_LOCK_TTL_MS = 30_000
const POLL_INTERVAL_MS = 100

type Options = {
  /** Max time to wait for the lock before running `fn` directly. */
  waitMs?: number
  /** TTL stamped on the lock row. Must exceed worst-case `fn` runtime. */
  lockTtlMs?: number
}

export async function withSingleFlight<T>(
  key: string,
  fn: () => Promise<T>,
  options: Options = {},
): Promise<T> {
  if (!sql) return fn()
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
  const holder = randomUUID()
  const start = Date.now()

  while (true) {
    const acquired = await tryAcquire(key, holder, lockTtlMs)
    if (acquired) {
      try {
        return await fn()
      } finally {
        await release(key, holder)
      }
    }
    if (Date.now() - start >= waitMs) {
      // Couldn't acquire in time. Run anyway — duplicate work in the
      // worst case is preferable to making the user wait forever.
      return fn()
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

async function tryAcquire(
  key: string,
  holder: string,
  lockTtlMs: number,
): Promise<boolean> {
  if (!sql) return false
  try {
    // Atomic acquire-or-reclaim:
    //   - INSERT succeeds when the row doesn't exist → we got the lock.
    //   - On conflict, UPDATE only fires if the existing row's TTL has
    //     passed → we reclaim it.
    //   - If conflict + still-valid existing row → no row returned → we
    //     didn't get it.
    const rows = await sql<Array<{ ok: number }>>`
      INSERT INTO single_flight_locks (key, holder, expires_at)
      VALUES (
        ${key},
        ${holder},
        NOW() + (${lockTtlMs} || ' milliseconds')::interval
      )
      ON CONFLICT (key) DO UPDATE
        SET holder = EXCLUDED.holder,
            expires_at = EXCLUDED.expires_at,
            created_at = NOW()
        WHERE single_flight_locks.expires_at < NOW()
      RETURNING 1 AS ok
    `
    return rows.length > 0
  } catch {
    // DB transient failure. Treat as "not acquired" so the caller falls
    // through to direct fn() and serves the user.
    return false
  }
}

async function release(key: string, holder: string): Promise<void> {
  if (!sql) return
  try {
    // Holder check ensures we don't release a lock that already
    // expired and got reclaimed by another waiter. Without it, a
    // slow `fn` whose lock expired could DELETE the new holder's
    // row when it finally returns.
    await sql`
      DELETE FROM single_flight_locks
      WHERE key = ${key} AND holder = ${holder}
    `
  } catch {
    // Best-effort cleanup. If this fails the lock will expire on TTL
    // and be reclaimable by the next acquirer.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
