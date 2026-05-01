-- Lazy bid-history tables for SR V2 / Transient / PND (Sovereign).
-- Mirrors `lazy_fnd_bids` (migration 002) — same shape, per-platform
-- prefix + appropriate scope columns for each marketplace's auction
-- identifier model.
--
-- Read path (mirrors Foundation):
--   1. Adapter reads from `lazy_<platform>_bids` keyed by the auction's
--      natural scope (token-pair for SR/TL since each token has at
--      most one active auction at a time; house+auctionId for PND
--      since auctionIds are per-house).
--   2. Freshness via MAX(last_indexed_at) per-scope vs `LAZY_TTL.<platform>Bids`
--      (30 min, same as foundationBids).
--   3. Stale → RPC scan (cheap: all four marketplaces have indexed
--      tokenId / auctionId on the bid event) → UPSERT each row.
--
-- This eliminates the per-render `eth_getLogs` cost for bid history
-- on hot tokens, dropping steady-state from "1 RPC every 30s" to
-- "1 RPC every 30 min" per token in active auction.

-- ── SuperRare V2 (Bazaar) ────────────────────────────────────────────
-- Bazaar's AuctionBid has indexed (_contractAddress, _bidder, _tokenId).
-- Per-token filter is server-side cheap. Multiple historical auctions
-- on the same token leave bids in the table; the read path filters to
-- the current auction's bidder cohort by block range when needed.
CREATE TABLE IF NOT EXISTS lazy_srv2_bids (
  nft_contract     TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  tx_hash          TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  bidder           TEXT NOT NULL,
  amount           TEXT NOT NULL,
  block_time       BIGINT NOT NULL,
  block_number     BIGINT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (nft_contract, token_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS lazy_srv2_bids_token_idx
  ON lazy_srv2_bids (nft_contract, token_id, block_number DESC);

-- ── Transient Labs (Auction House) ───────────────────────────────────
-- AuctionBid has indexed (sender, nftAddress, tokenId) AND carries the
-- full Listing struct (which contains a globally-unique `id`). The
-- adapter filters to the CURRENT listing's id when reading back so
-- bids from prior listings on the same token don't leak into the
-- current bid history.
CREATE TABLE IF NOT EXISTS lazy_tl_bids (
  nft_contract     TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  tx_hash          TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  -- TL's globally-unique listing.id from the event payload. Lets the
  -- read path filter out bids from prior listings on the same token.
  listing_id       TEXT NOT NULL,
  bidder           TEXT NOT NULL,
  amount           TEXT NOT NULL,
  block_time       BIGINT NOT NULL,
  block_number     BIGINT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (nft_contract, token_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS lazy_tl_bids_token_idx
  ON lazy_tl_bids (nft_contract, token_id, block_number DESC);
CREATE INDEX IF NOT EXISTS lazy_tl_bids_listing_idx
  ON lazy_tl_bids (nft_contract, token_id, listing_id, block_number DESC);

-- ── PND / Sovereign Auction House ────────────────────────────────────
-- Per-house auctionIds. The adapter passes (house, auctionId); we key
-- the same way so multiple sovereign houses don't collide on the
-- numeric auctionId.
CREATE TABLE IF NOT EXISTS lazy_pnd_bids (
  house            TEXT NOT NULL,
  auction_id       TEXT NOT NULL,
  tx_hash          TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  bidder           TEXT NOT NULL,
  amount           TEXT NOT NULL,
  block_time       BIGINT NOT NULL,
  block_number     BIGINT NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (house, auction_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS lazy_pnd_bids_auction_idx
  ON lazy_pnd_bids (house, auction_id, block_number DESC);
