-- Lazy indexer tables. Populated by the web app's RPC fallback paths on
-- first miss per (artist/token); subsequent reads collapse to a Postgres
-- point lookup. NOT in Ponder's `ponder` schema — Ponder owns its tables
-- and their `_reorg__` shadows for chain-reorg consistency. These are
-- in `public` and live alongside `cache_entries`.

-- ─── Foundation NFTMarket: sales (auction-finalized + buy-now-accepted) ──
-- One row per token; on each refresh, UPSERT the latest sale we found.
-- last_indexed_at lets the read path decide whether to trust the row or
-- re-scan (covers the case where a new sale happened after we cached one).
CREATE TABLE IF NOT EXISTS lazy_fnd_sales (
  nft_contract     TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  price_wei        TEXT NOT NULL,
  block_time       BIGINT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('auction', 'buyNow')),
  tx_hash          TEXT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (nft_contract, token_id)
);

-- ─── Foundation NFTMarket: bid history per auction ───────────────────────
-- Bid stream for a Foundation auction. Read path returns the full set
-- ordered newest-first; writers UPSERT each bid by tx-hash composite key
-- (multiple bids can share a tx via aggregator contracts).
CREATE TABLE IF NOT EXISTS lazy_fnd_bids (
  auction_id       TEXT NOT NULL,
  tx_hash          TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  bidder           TEXT NOT NULL,
  amount           TEXT NOT NULL,
  block_time       BIGINT NOT NULL,
  block_number     BIGINT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (auction_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS lazy_fnd_bids_auction_idx
  ON lazy_fnd_bids (auction_id, block_number DESC);

-- ─── Foundation NFTMarket: cancellable seller listings ───────────────────
-- Per-seller snapshot of currently-active reserve auctions (no bids yet)
-- and buy-now listings. Stored as a single JSONB blob keyed by seller —
-- the read path is "everything for this seller", so storing as a list
-- avoids per-row joins on a hot panel-open path.
CREATE TABLE IF NOT EXISTS lazy_fnd_seller_listings (
  seller            TEXT PRIMARY KEY,
  auctions          JSONB NOT NULL,
  buy_nows          JSONB NOT NULL,
  last_indexed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Foundation: per-artist token discovery ──────────────────────────────
-- Unified table for tokens an artist minted on the shared 1/1 contract OR
-- on per-artist collection contracts. Used by `discoverArtistTokenRefs`.
CREATE TABLE IF NOT EXISTS lazy_fnd_artist_tokens (
  creator          TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  block_number     BIGINT NOT NULL,
  log_index        INTEGER NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (creator, contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_fnd_artist_tokens_creator_idx
  ON lazy_fnd_artist_tokens (creator, block_number DESC, log_index DESC);

-- Per-artist scan-completion marker. Lets the read path distinguish "we've
-- never indexed this artist" from "we've indexed and they have zero
-- tokens." Bumping `last_indexed_at` here is what keeps the read fresh.
CREATE TABLE IF NOT EXISTS lazy_fnd_artist_index_status (
  creator          TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
