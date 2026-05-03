-- Single-flight lock table. Used by `withSingleFlight` in
-- apps/web/src/lib/single-flight.ts to serialize concurrent expensive
-- operations (artist page render, etc.) on the same key.
--
-- Why a custom table instead of pg_advisory_lock?
--   Railway's Postgres uses PgBouncer-style pooling. In transaction-mode
--   pooling, advisory locks acquired in one transaction don't persist for
--   the next, which silently breaks the single-flight pattern. A
--   TTL-based custom table works correctly under any pooling mode and
--   self-heals if a holder crashes (the lock expires and is reclaimable).
--
-- The TTL bound is critical: a Netlify function killed mid-execution
-- (memory limit, timeout) might never DELETE its row. After
-- `expires_at` passes, the next acquirer can take the lock by UPDATE
-- in the ON CONFLICT clause. Pick TTL ≥ the longest legitimate
-- single-flight body so a slow render doesn't lose its lock to a
-- waiter mid-fetch.

CREATE TABLE IF NOT EXISTS single_flight_locks (
  key         TEXT        PRIMARY KEY,
  -- Random per-acquire token. Lets the releaser confirm it still owns
  -- the lock before deleting (in case a slow holder's lock expired and
  -- a waiter took it — the original holder shouldn't release the new
  -- holder's lock).
  holder      TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup pattern is point-by-key (PRIMARY KEY covers it). The expires_at
-- index supports a periodic cleanup job if we ever add one — for now
-- expired rows are reclaimed in-place by the next acquirer's UPDATE.
CREATE INDEX IF NOT EXISTS single_flight_locks_expires_idx
  ON single_flight_locks (expires_at);
