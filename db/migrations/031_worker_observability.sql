-- Persist enough deployment identity to diagnose mixed-schema/runtime drift,
-- and bound raw iteration telemetry without losing long-term cost trends.

ALTER TABLE worker_iterations
  ADD COLUMN IF NOT EXISTS build_sha TEXT,
  ADD COLUMN IF NOT EXISTS indexer_schema TEXT;

CREATE TABLE IF NOT EXISTS worker_daily_metrics (
  day          DATE NOT NULL,
  task         TEXT NOT NULL,
  iterations   BIGINT NOT NULL,
  errors       BIGINT NOT NULL,
  scope_count  BIGINT NOT NULL,
  rpc_calls    BIGINT NOT NULL,
  rows_written BIGINT NOT NULL,
  duration_ms  BIGINT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, task)
);

CREATE INDEX IF NOT EXISTS worker_iterations_started_at_idx
  ON worker_iterations (started_at);
