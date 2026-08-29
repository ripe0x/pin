-- SuperRare delist reads use the worker's existing fixed-Bazaar scan. Store
-- the auction duration already returned by tokenAuctions, plus a durable
-- watermark that lets the web distinguish a complete empty result for a
-- known artist from a scanner that is still catching up or stale. The worker
-- deliberately ignores sellers outside known_artists to preserve the spend
-- ceiling; the web keeps those arbitrary-wallet results explicitly partial.

ALTER TABLE srv2_active_auctions
  ADD COLUMN IF NOT EXISTS duration_seconds BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS srv2_listing_coverage (
  scope                  TEXT PRIMARY KEY,
  indexed_through_block  BIGINT NOT NULL,
  finalized_target_block BIGINT NOT NULL,
  complete               BOOLEAN NOT NULL,
  last_success_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT srv2_listing_coverage_global_check CHECK (scope = 'global')
);
