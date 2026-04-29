-- Shared L2 cache table. See apps/web/src/lib/pg-cache.ts for the
-- read/write/invalidate logic. Keys are dot/colon-delimited strings that
-- mirror the `unstable_cache` keyParts shape, e.g.:
--
--   auction:0xbf5a4e8d...:1
--   active-auction-count:0x5678...
--   ens:0x1234...
--   token-metadata:0xbf5a4e8d...:1
--
-- Values are arbitrary JSON-serializable shapes. Bigints are stringified
-- by the calling layer (same convention as the existing `unstable_cache`
-- wrappers) since neither JSONB nor `unstable_cache` round-trip bigints.
--
-- Index on expires_at supports the cleanup job; the primary key already
-- covers point lookups by key.

CREATE TABLE IF NOT EXISTS cache_entries (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cache_entries_expires_idx
  ON cache_entries (expires_at);
