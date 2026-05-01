-- Transient Labs lazy index. Mirrors the SR V2 schema (006) with
-- `tl_*` table prefixes. Reuses `lazy_scan_cursors` (added in 006)
-- for the auction-house event scanner with key 'tl_auction_house'.
--
-- Scope:
--   - Artist-side mint discovery (deferred; column reserved for the
--     follow-up that enumerates per-artist contracts via the Universal
--     Deployer). Tables created now so the lazy library helpers don't
--     have to be retrofit later.
--   - Settled-auction sales (auction + buy-now; both event types are
--     indexed by `nftAddress` + `tokenId` on TL Auction House, so per-
--     token last-sale lookups don't need a platform-wide bulk scan
--     like SR V2 does for Sold/AcceptOffer).
--   - Collector-side ownership snapshot (deferred; same reason as
--     artist gallery — needs per-artist contract enumeration).
--   - Active-listing state for the home grid (incrementally scanned
--     from ListingConfigured / AuctionBid / AuctionSettled /
--     BuyNowFulfilled / ListingCanceled events).

-- ── Artist-side ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lazy_tl_artist_tokens (
  creator          TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  block_number     BIGINT NOT NULL,
  log_index        INTEGER NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (creator, contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_tl_artist_tokens_creator_idx
  ON lazy_tl_artist_tokens (creator, block_number DESC);

CREATE TABLE IF NOT EXISTS lazy_tl_artist_status (
  creator          TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sales (auction + buy-now) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lazy_tl_sales (
  nft_contract     TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  price_wei        TEXT NOT NULL,
  block_time       BIGINT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('auction', 'buyNow')),
  tx_hash          TEXT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (nft_contract, token_id)
);

-- ── Collector-side ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lazy_tl_collector_tokens (
  wallet           TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet, contract, token_id)
);
CREATE TABLE IF NOT EXISTS lazy_tl_collector_status (
  wallet           TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Active listings for the home grid ───────────────────────────────
-- One row per (contract, tokenId). The TL `Listing` struct's `type_`
-- enum discriminates auctions from buy-nows; we surface only auctions
-- (status='active') in the home grid for parity with SR V2 / PND. The
-- `listing_type` column stores the raw enum value so future code can
-- filter without a re-scan.
CREATE TABLE IF NOT EXISTS lazy_tl_active_auctions (
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  seller           TEXT NOT NULL,
  reserve_wei      TEXT NOT NULL,
  current_bid_wei  TEXT,
  current_bidder   TEXT,
  -- Pre-bid: 0 (auction created, no timer running yet).
  -- Post-bid: unix ts of first bid + auction duration.
  end_time         BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('active', 'settled', 'cancelled')),
  -- Raw `Listing.type_` enum value (1=Scheduled auction, 2=Reserve
  -- auction, 3=BuyNow per current TL source). Stored so we can later
  -- distinguish drop-style vs reserve-style flows without re-scanning.
  listing_type     SMALLINT NOT NULL DEFAULT 0,
  started_at_block BIGINT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_tl_active_auctions_status_idx
  ON lazy_tl_active_auctions (status, end_time);
