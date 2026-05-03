-- Foundation NFTMarket active-auction lazy index. Mirrors the per-platform
-- shape of `lazy_srv2_active_auctions` (006) and `lazy_tl_active_auctions`
-- (007), with two Foundation-specific differences:
--
--   1. Most NFTMarket events (Bid / Finalized / Canceled / Updated /
--      Invalidated) are keyed only by `auctionId` — only `ReserveAuctionCreated`
--      carries the (contract, tokenId) pair. So the scanner needs to look up
--      auctions by id when applying later events. We use `auction_id` as the
--      primary key and add a (contract, token_id) lookup index.
--
--   2. NFTMarket is generic over any ERC721; an auction's seller may or may
--      not be the token creator. The `creator` column is the same artist-
--      seller filter used by SR V2 / TL — backfilled by the scanner via
--      `tokenCreator(uint256)` then `owner()` (Foundation's per-artist
--      contracts follow the Universal Deployer convention where the
--      contract owner is the artist).
--
-- Reads filter to status='active' and creator IS NOT NULL AND creator = seller
-- so secondary listings (collector reselling someone else's work) drop out.

CREATE TABLE IF NOT EXISTS lazy_fnd_active_auctions (
  auction_id       BIGINT PRIMARY KEY,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  seller           TEXT NOT NULL,
  reserve_wei      TEXT NOT NULL,
  current_bid_wei  TEXT,
  current_bidder   TEXT,
  -- Pre-bid: 0 (auction created, no timer running yet).
  -- Post-bid: unix ts emitted directly by ReserveAuctionBidPlaced (no
  -- chain-head approximation needed — the contract emits the exact
  -- post-extension end time on every bid).
  end_time         BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('active', 'settled', 'cancelled')),
  started_at_block BIGINT NOT NULL,
  creator          TEXT,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lazy_fnd_active_auctions_status_idx
  ON lazy_fnd_active_auctions (status, end_time);
CREATE INDEX IF NOT EXISTS lazy_fnd_active_auctions_token_idx
  ON lazy_fnd_active_auctions (contract, token_id);
CREATE INDEX IF NOT EXISTS lazy_fnd_active_auctions_creator_idx
  ON lazy_fnd_active_auctions (status, creator) WHERE status = 'active';
