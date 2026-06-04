-- First-mint block time for Mint protocol editions. Worker-owned (writer:
-- scan-mint-clones via scanErc1155MintsFromZero, plus an RPC-free backfill).
--
-- Powers two things with ZERO extra chain reads:
--   - The homepage activity feed's Mint-mint branch orders on a real unix
--     block time. artist_tokens.mint_block is a block NUMBER, not a timestamp,
--     and the feed sorts every branch on unix seconds — so we precompute the
--     first mint's block_time here rather than join token_1155_mints at query
--     time (the feed is hot + 30s-cached).
--   - The live mint window. Mint editions are open for a fixed 24h
--     (MINT_DURATION) from create(); we derive closeAt = mint_time + 24h
--     instead of reading the immutable mintOpenUntil(tokenId) on-chain. The
--     contract still enforces the true window, so a stale-edge mint reverts.
--
-- mint_time is the block_time of the FIRST mint event (the artist_tokens row is
-- deduped to first-mint via ON CONFLICT DO NOTHING). NULL for non-Mint rows and
-- for not-yet-backfilled editions.

ALTER TABLE artist_tokens
  ADD COLUMN IF NOT EXISTS mint_time BIGINT;  -- unix seconds of first mint

-- Partial to the Mint rows so the feed branch is a small index scan ordered by
-- recency. Stays tiny (only known-artist Mint editions).
CREATE INDEX IF NOT EXISTS artist_tokens_mint_feed_idx
  ON artist_tokens (mint_time DESC)
  WHERE platform = 'mint';
