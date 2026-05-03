-- Per-artist auction-scan freshness markers. Mirrors the per-platform
-- artist-token status tables (`lazy_*_artist_status`) but tracks the
-- freshness of the per-artist active-auction scan separately.
--
-- The active-auction lazy tables (`lazy_srv2_active_auctions`,
-- `lazy_tl_active_auctions`, `lazy_fnd_active_auctions`) are now
-- populated per-artist on artist-page loads (filtered `getLogs` calls
-- on each marketplace contract, scoped to that artist's seller-indexed
-- topic). These status tables tell the home grid which artists have
-- been scanned recently — rows for unscanned / stale artists fall off
-- via a JOIN + `last_indexed_at > NOW() - INTERVAL '24 hours'` filter.
--
-- The pre-existing global cron scanner (and its `lazy_scan_cursors`
-- rows for `srv2_bazaar`, `tl_auction_house`, `fnd_nft_market`) is
-- being removed in the same change. Those cursor rows become orphaned
-- — harmless, no migration needed.

CREATE TABLE IF NOT EXISTS lazy_srv2_artist_auction_status (
  artist           TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lazy_tl_artist_auction_status (
  artist           TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lazy_fnd_artist_auction_status (
  artist           TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
