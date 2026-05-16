-- Drop the SR V2 + TL lazy active-auction tables now that Ponder
-- owns this state. Web reads moved to `ponder_v*.srv2_auctions` and
-- `ponder_v*.tl_auctions` in PR #62; this drops the now-unused write
-- targets and the per-artist scan-freshness markers that fed them.
--
-- Foundation's `lazy_foundation_active_auctions` stays — it's a
-- different shape that isn't yet covered by the Ponder migration.
--
-- Idempotent: `DROP TABLE IF EXISTS` so re-runs are no-ops. CASCADE
-- in case any stale view dependencies remain (none expected; the
-- web-side reader helpers were removed in the same PR as this
-- migration).

DROP TABLE IF EXISTS lazy_srv2_active_auctions CASCADE;
DROP TABLE IF EXISTS lazy_tl_active_auctions CASCADE;
DROP TABLE IF EXISTS lazy_srv2_artist_auction_status CASCADE;
DROP TABLE IF EXISTS lazy_tl_artist_auction_status CASCADE;
