-- Durable artist-refresh queue and audit record.
--
-- The web app inserts one row before asking the worker to scan. The worker
-- claims queued rows with FOR UPDATE SKIP LOCKED, renews lease_expires_at while
-- running, and records a terminal result. A crashed worker leaves a durable
-- queued row, or an expired running lease, which another worker can reclaim.
-- Keeping the queue in the existing Postgres avoids a Redis/BullMQ service.

CREATE TABLE IF NOT EXISTS refresh_jobs (
  id                  UUID PRIMARY KEY,
  artist              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'partial', 'complete', 'failed')),
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  heartbeat_at        TIMESTAMPTZ,
  lease_expires_at    TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  result              JSONB NOT NULL DEFAULT '{}'::jsonb,
  error               TEXT,
  cache_invalidated_at TIMESTAMPTZ,
  CHECK (artist ~ '^0x[0-9a-f]{40}$'),
  CHECK (finished_at IS NULL OR status IN ('partial', 'complete', 'failed'))
);

-- At most one accepted job per artist may be queued or running. The web route
-- returns this row for duplicate clicks instead of creating parallel scans.
CREATE UNIQUE INDEX IF NOT EXISTS refresh_jobs_one_active_artist_idx
  ON refresh_jobs (artist)
  WHERE status IN ('queued', 'running');

-- Worker queue claim: queued jobs first, then expired leases after a restart.
CREATE INDEX IF NOT EXISTS refresh_jobs_claim_idx
  ON refresh_jobs (requested_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS refresh_jobs_expired_lease_idx
  ON refresh_jobs (lease_expires_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS refresh_jobs_artist_requested_idx
  ON refresh_jobs (artist, requested_at DESC);
