-- Durable evidence for finalized transfer rows and resumable PND token-mint
-- discovery. Both additions are compatible with existing readers.

ALTER TABLE token_transfers
  ADD COLUMN IF NOT EXISTS block_hash TEXT;

CREATE TABLE IF NOT EXISTS pnd_token_discovery (
  contract        TEXT NOT NULL,
  token_id        TEXT NOT NULL,
  anchor_block    BIGINT NOT NULL,
  next_to_block   BIGINT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'found', 'unsupported', 'failed')),
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);

CREATE INDEX IF NOT EXISTS pnd_token_discovery_pending_idx
  ON pnd_token_discovery (status, updated_at)
  WHERE status = 'pending';

-- Opaque provider page tokens must survive worker restarts. A scanner may
-- only advance its block cursor after the final page is processed.
CREATE TABLE IF NOT EXISTS worker_pagination (
  task          TEXT NOT NULL,
  scope         TEXT NOT NULL,
  page_key      TEXT NOT NULL,
  from_block    BIGINT NOT NULL,
  to_block      BIGINT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task, scope)
);
