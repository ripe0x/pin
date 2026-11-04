-- scan_backoff: per-(task, scope) failure memory for the worker
-- (audit M2, M3, M5; #295). apps/worker/src/backoff.ts owns the rules.
--
-- A scope (a contract, an artist:contract pair, an auctioned token, an
-- artist awaiting onboarding) that fails is skipped until retry_at, with
-- the delay doubling per consecutive failure, so one deterministic
-- failure can't be retried every tick forever or starve the rest of a
-- task's per-tick budget. A success deletes the row. Rows untouched for
-- 30 days are pruned by the prune-retention task.
--
-- Used by: scan-token-transfers (per contract; group failures isolate a
-- contract, solo failures back off), scan-fnd-collections /
-- scan-tl-clones / scan-mint-clones (per artist:contract),
-- scan-pnd-auction-tokens (negative cache per contract:token),
-- seed-known-artists (onboarding attempts per artist),
-- warm-contract-identity (transient probe failures per contract).

CREATE TABLE IF NOT EXISTS scan_backoff (
  task             TEXT NOT NULL,
  scope            TEXT NOT NULL,
  failures         INTEGER NOT NULL DEFAULT 1,
  retry_at         TIMESTAMPTZ NOT NULL,
  last_error       TEXT,
  first_failed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task, scope)
);

CREATE INDEX IF NOT EXISTS scan_backoff_updated_idx
  ON scan_backoff (updated_at);
