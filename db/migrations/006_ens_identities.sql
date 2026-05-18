-- ens_identities: ENS reverse + avatar per address. Worker-owned
-- (writer: warm-ens).
--
-- Slow background refresh. ENS records change rarely; treating this
-- as a permanent index instead of a cache eliminates per-page-render
-- ENS resolution.
--
-- A row exists iff we've ever attempted resolution. Both ens_name and
-- avatar_url are nullable — a row with both null means "we tried, this
-- address has no ENS record." Store it anyway so we never re-attempt
-- on every cycle.

CREATE TABLE IF NOT EXISTS ens_identities (
  address      TEXT PRIMARY KEY,
  ens_name     TEXT,
  avatar_url   TEXT,
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ens_identities_resolved_at_idx
  ON ens_identities (resolved_at);
