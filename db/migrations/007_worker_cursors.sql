-- worker_cursors: per-(task, scope) block cursor. Drives incremental
-- chain scans for every worker task.
--
-- `scope` is task-specific: artist-or-contract for per-platform scans,
-- contract for token-transfers, etc. The PK keeps lookups point-fast
-- and atomic UPSERT writes safe under concurrent invocations.

CREATE TABLE IF NOT EXISTS worker_cursors (
  task           TEXT NOT NULL,
  scope          TEXT NOT NULL,
  last_block     BIGINT NOT NULL,
  last_run_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task, scope)
);
