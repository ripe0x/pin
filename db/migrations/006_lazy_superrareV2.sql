-- SuperRare V2 lazy index. Mirrors the per-platform convention used by
-- foundation (002), manifold (003), collector (004), classification
-- (005). All tables live in the `public` schema so they don't collide
-- with Ponder's `ponder` schema (which has its own `_reorg__` machinery).
--
-- Scope:
--   - Artist-side mint discovery
--   - Settled-auction sales (Sold/AcceptOffer deferred — events lack
--     indexed _tokenId so per-token filter is impossible; covered as
--     a separate platform-wide bulk-scan follow-up)
--   - Collector-side ownership snapshot
--   - Active-auction state for the home grid (incrementally scanned
--     from Bazaar's NewAuction/AuctionBid/AuctionSettled/CancelAuction
--     events and kept in sync via lazy_scan_cursors)

-- ── Artist-side ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lazy_srv2_artist_tokens (
  creator          TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  block_number     BIGINT NOT NULL,
  log_index        INTEGER NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (creator, contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_srv2_artist_tokens_creator_idx
  ON lazy_srv2_artist_tokens (creator, block_number DESC);

CREATE TABLE IF NOT EXISTS lazy_srv2_artist_status (
  creator          TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sales (auction-settled only for MVP) ────────────────────────────
CREATE TABLE IF NOT EXISTS lazy_srv2_sales (
  nft_contract     TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  price_wei        TEXT NOT NULL,
  block_time       BIGINT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('auction')),
  tx_hash          TEXT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (nft_contract, token_id)
);

-- ── Collector-side ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lazy_srv2_collector_tokens (
  wallet           TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet, contract, token_id)
);
CREATE TABLE IF NOT EXISTS lazy_srv2_collector_status (
  wallet           TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Active auctions for the home grid ───────────────────────────────
-- Updated incrementally via a block-range scan of NewAuction /
-- AuctionBid / AuctionSettled / CancelAuction events on Bazaar.
-- Reads filter to status='active'.
CREATE TABLE IF NOT EXISTS lazy_srv2_active_auctions (
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  seller           TEXT NOT NULL,
  reserve_wei      TEXT NOT NULL,
  current_bid_wei  TEXT,
  current_bidder   TEXT,
  -- Pre-bid: 0 (auction created, no timer running yet).
  -- Post-bid: unix ts of first bid + auction length, extended on late bids.
  end_time         BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('active', 'settled', 'cancelled')),
  started_at_block BIGINT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_srv2_active_auctions_status_idx
  ON lazy_srv2_active_auctions (status, end_time);

-- ── Generic scan cursor (one row per scan_key) ──────────────────────
-- Tracks the last block scanned for each platform's incremental event
-- pull. Reusable for future platforms that need a similar pattern
-- (Zora, future SR contracts, etc.). For SR V2 the key is 'srv2_bazaar'.
CREATE TABLE IF NOT EXISTS lazy_scan_cursors (
  scan_key         TEXT PRIMARY KEY,
  last_block       BIGINT NOT NULL,
  last_scanned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
