-- cache_entries: short-TTL JSON KV. The ONLY mutable-with-TTL store
-- in the system. Used by web's `lib/cache.ts` (pgCache wrapper) for:
--   - on-demand live auction state (SR/TL active auctions per artist)
--   - on-demand current buy-now prices
--   - on-demand current owner (when token_owners row is stale)
--   - any other genuinely-live read that needs sub-30s freshness
--
-- Everything else lives in permanent stores (artist_tokens,
-- token_owners, token_metadata, contract_identity, ens_identities).
-- This table is intentionally small.
--
-- The expires_at index supports a periodic cleanup task; the PK
-- already covers point reads.

CREATE TABLE IF NOT EXISTS cache_entries (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cache_entries_expires_idx
  ON cache_entries (expires_at);
