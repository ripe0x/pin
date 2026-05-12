-- Persistent ENS identity index. Replaces the `efp-ens:*` / `ens:*` /
-- `ens-avatar:*` keys in `cache_entries`, which had a 24h TTL and re-resolved
-- every active address daily even when nothing had changed. ENS records change
-- rarely, so treating them as a permanent index instead of a cache eliminates
-- repeated upstream fetches (EFP HTTPS API + ENS RPC).
--
-- Row contract: a row exists iff we've ever attempted resolution for this
-- address. Both `ens_name` and `avatar_url` are nullable: a row with both
-- null means "we tried, this address has no ENS record" — store it anyway
-- so we don't re-attempt on the next read. Distinguish from "never fetched"
-- by row presence.
--
-- Re-fetch policy: by default, never. When a user updates their ENS record
-- the stored row will be stale; a manual invalidation route (or a background
-- sweep keyed on `resolved_at`) can refresh entries on demand. `resolved_at`
-- supports that without a schema change.
--
-- Address is always lowercase to match the convention used everywhere else
-- in this codebase (artist-queries.ts, pgCache keys, indexer rows).

CREATE TABLE IF NOT EXISTS ens_identities (
  address      TEXT PRIMARY KEY,
  ens_name     TEXT,
  avatar_url   TEXT,
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports the optional "re-resolve entries older than N days" sweep
-- without a full table scan.
CREATE INDEX IF NOT EXISTS ens_identities_resolved_at_idx
  ON ens_identities (resolved_at);
