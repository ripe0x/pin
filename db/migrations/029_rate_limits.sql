-- Shared fixed-window counters for the web app's API rate limiter
-- (apps/web/src/lib/rate-limit.ts).
--
-- Serverless hosts run many function instances, each with its own memory,
-- so an in-process counter alone only bounds one instance. This table holds
-- the window across all of them. One row per (namespace, client) key; the
-- key is a sha256 prefix, so no raw client IP is stored.
--
-- The web app increments with a single atomic upsert:
--   INSERT ... ON CONFLICT (key) DO UPDATE SET count = <reset or add>, ...
-- and fails open if this table is absent or the query errors, so the app
-- keeps serving before this migration is applied.
--
-- Stale rows (window older than a day) are pruned opportunistically by the
-- web app itself.

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx
  ON rate_limits (window_start);
