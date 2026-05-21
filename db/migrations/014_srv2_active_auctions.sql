-- SR V2 Bazaar active auctions. Worker-owned (writer:
-- scan-srv2-active-auctions). Brings SR live-state reads onto the
-- same pattern as PND + Foundation: web reads a Postgres table; the
-- worker absorbs the chain-scan cost off the request path.
--
-- Replaces v2's `lib/onchain.ts:getActiveSrV2AuctionMap` chunked-getLogs
-- approach. That worked at 2M-block chunks on Alchemy but breaks down
-- on drpc free (10K-block cap → 790 chunks per artist page render).
--
-- Status transitions:
--   'active'    — auction live, tokenAuctions(contract, tokenId) returns
--                 a non-zero auctionCreator at last scan.
--   'settled'   — auctionCreator returned zero AND we have a prior row;
--                 entry deleted by AuctionSettled contract call.
--   'cancelled' — same shape as settled; we can't distinguish from the
--                 storage read alone. The activity feed UI uses the
--                 lifecycle log for that distinction; this table is for
--                 the "is this active right now?" check only.
--
-- Currency: ETH only. ERC-20 auctions are out of scope for the migrate
-- flow today and the home grid only surfaces ETH; the scanner filters
-- them out before insertion.

CREATE TABLE IF NOT EXISTS srv2_active_auctions (
  contract            TEXT NOT NULL,
  token_id            TEXT NOT NULL,
  seller              TEXT NOT NULL,
  reserve_wei         TEXT NOT NULL,
  current_bid_wei     TEXT NOT NULL DEFAULT '0',
  current_bidder      TEXT,
  end_time            BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL CHECK (status IN ('active', 'settled', 'cancelled')),
  last_observed_block BIGINT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);

-- Page reads filter (seller, status='active'); home-grid-style queries
-- filter (status='active', end_time ASC).
CREATE INDEX IF NOT EXISTS srv2_active_auctions_seller_status_idx
  ON srv2_active_auctions (seller, status);
CREATE INDEX IF NOT EXISTS srv2_active_auctions_status_end_idx
  ON srv2_active_auctions (status, end_time)
  WHERE status = 'active';
