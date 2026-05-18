-- worker_iterations: per-task audit log. Powers /metrics and the
-- weekly cost-invariant check (RPC volume should track
-- known_artists × cadence; deviations signal a scanner regression).
--
-- Retention: prune rows older than 30 days via a periodic task (or
-- just let them accumulate — at one row per task per cadence × ~10
-- tasks, even a year of audit logs is <1M rows).

CREATE TABLE IF NOT EXISTS worker_iterations (
  id            BIGSERIAL PRIMARY KEY,
  task          TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ NOT NULL,
  scope_count   INTEGER NOT NULL DEFAULT 0,
  rpc_calls     INTEGER NOT NULL DEFAULT 0,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  ok            BOOLEAN NOT NULL,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS worker_iterations_task_started_idx
  ON worker_iterations (task, started_at DESC);
CREATE INDEX IF NOT EXISTS worker_iterations_started_idx
  ON worker_iterations (started_at DESC);
