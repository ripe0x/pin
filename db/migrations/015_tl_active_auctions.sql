-- TL Auction House active listings. Mirror of srv2_active_auctions
-- (migration 014) for the Transient Labs marketplace.
--
-- TL's listing struct on getListing(nftAddress, tokenId) carries a
-- `type_` enum: 0=NotConfigured, 1=Scheduled auction, 2=Reserve auction,
-- 3=BuyNow. We surface type_=2 (Reserve) for parity with SR + PND; the
-- other types are stored in the column but filtered at read time.
--
-- `type_=0` after a previous non-zero value = the listing was settled
-- or cancelled. Scanner transitions status accordingly.

CREATE TABLE IF NOT EXISTS tl_active_auctions (
  contract            TEXT NOT NULL,
  token_id            TEXT NOT NULL,
  seller              TEXT NOT NULL,
  reserve_wei         TEXT NOT NULL,
  current_bid_wei     TEXT NOT NULL DEFAULT '0',
  current_bidder      TEXT,
  end_time            BIGINT NOT NULL DEFAULT 0,
  listing_type        SMALLINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL CHECK (status IN ('active', 'settled', 'cancelled')),
  last_observed_block BIGINT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);

CREATE INDEX IF NOT EXISTS tl_active_auctions_seller_status_idx
  ON tl_active_auctions (seller, status);
CREATE INDEX IF NOT EXISTS tl_active_auctions_status_end_idx
  ON tl_active_auctions (status, end_time)
  WHERE status = 'active';
