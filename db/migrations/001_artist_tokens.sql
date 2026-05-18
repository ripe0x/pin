-- artist_tokens: every token attributed to an artist, across every
-- platform. Worker-owned (writers: scan-fnd-collections, scan-mint-clones,
-- scan-tl-clones, scan-manifold). Web reads only.
--
-- Permanent store. No TTL. The worker advances cursors and inserts new
-- rows; the web app's `discoverArtistTokens` per-platform reads collapse
-- to a single SELECT against this table.
--
-- platform values:
--   'fnd-shared'       — populated by Ponder (FoundationNFT shared 1/1)
--   'fnd-collection'   — populated by worker scan-fnd-collections
--   'srv2-shared'      — populated by Ponder (SuperRareNFT shared 1/1)
--   'mint'             — populated by worker scan-mint-clones
--   'tl'               — populated by worker scan-tl-clones
--   'manifold'         — populated by worker scan-manifold
--
-- Note: 'fnd-shared' and 'srv2-shared' are read from Ponder tables
-- (fnd_artist_tokens, srv2_artist_tokens) and UNION'd at read time;
-- they do NOT live in this public.artist_tokens table. The platform
-- column documents the full set for orientation.

CREATE TABLE IF NOT EXISTS artist_tokens (
  artist           TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  platform         TEXT NOT NULL,
  mint_block       BIGINT NOT NULL,
  mint_log_index   INTEGER NOT NULL,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);

CREATE INDEX IF NOT EXISTS artist_tokens_artist_idx
  ON artist_tokens (artist, mint_block DESC, mint_log_index DESC);
CREATE INDEX IF NOT EXISTS artist_tokens_artist_platform_idx
  ON artist_tokens (artist, platform);
