-- refresh_jobs: durable queue + audit record for on-demand refreshes
-- (#297). Replaces the worker's in-memory Set queues, which lost every
-- accepted job on a worker restart and made the web's enqueue depend on
-- the worker being reachable.
--
--   web    INSERTs a 'queued' row (ON CONFLICT DO NOTHING against the
--          one-active-job index below), after its cooldown check
--          (apps/web/src/lib/refresh-jobs.ts).
--   worker claims the oldest due row with FOR UPDATE SKIP LOCKED, renews
--          heartbeat_at while running, and records done / failed. A failed
--          attempt goes back to 'queued' with run_after pushed out
--          (backoff) until max_attempts. A 'running' row whose heartbeat
--          is older than the lease (worker crash or restart) is reclaimed
--          the same way (apps/worker/src/refresh-queue.ts).
--
-- kind/target:
--   artist  target = lowercase 0x address
--   token   target = '<lowercase contract>:<decimal token id>'
--
-- Rows older than 30 days in a terminal state are pruned by
-- prune-retention.

CREATE TABLE IF NOT EXISTS refresh_jobs (
  id                    BIGSERIAL PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('artist', 'token')),
  target                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts          INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  enqueued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Earliest time the next attempt may start (retry backoff).
  run_after             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  heartbeat_at          TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  last_error            TEXT,
  -- Worker-written summary, e.g. {"added": 3, "total": 120} for artists.
  result                JSONB,
  -- Set by the web the first time it observes a finished artist job and
  -- evicts that artist's cached gallery refs, so later polls don't
  -- re-invalidate.
  cache_invalidated_at  TIMESTAMPTZ,
  CHECK (
    (kind = 'artist' AND target ~ '^0x[0-9a-f]{40}$')
    OR (kind = 'token' AND target ~ '^0x[0-9a-f]{40}:[0-9]+$')
  ),
  CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL))
);

-- At most one active (queued or running) job per target. The web's
-- INSERT ... ON CONFLICT DO NOTHING relies on this; a duplicate click
-- reads the existing active row instead of creating a parallel scan.
CREATE UNIQUE INDEX IF NOT EXISTS refresh_jobs_one_active_idx
  ON refresh_jobs (kind, target)
  WHERE status IN ('queued', 'running');

-- Claim: oldest due queued job of a kind.
CREATE INDEX IF NOT EXISTS refresh_jobs_claim_idx
  ON refresh_jobs (kind, run_after, id)
  WHERE status = 'queued';

-- Reclaim: running jobs with an expired heartbeat.
CREATE INDEX IF NOT EXISTS refresh_jobs_running_idx
  ON refresh_jobs (heartbeat_at)
  WHERE status = 'running';

-- Status + cooldown reads: latest job for a target.
CREATE INDEX IF NOT EXISTS refresh_jobs_target_idx
  ON refresh_jobs (kind, target, id DESC);

-- Retention.
CREATE INDEX IF NOT EXISTS refresh_jobs_finished_idx
  ON refresh_jobs (finished_at)
  WHERE finished_at IS NOT NULL;
