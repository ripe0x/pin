-- SuperRare cancellable seller-listings: per-seller snapshot. Mirrors
-- `lazy_fnd_seller_listings` (migration 002) — same shape, same intent.
--
-- The web app's `/api/seller-listings/[address]` route was scanning years of
-- SR Bazaar history via chunked `eth_getLogs` on every cold seller view,
-- which spiked latency above Netlify's function timeout and 502'd /delist
-- for prolific SR artists. This table is the per-seller write-through cache:
-- the RPC scan runs at most once per seller per TTL window, the result lives
-- in pg, and every other reader for that seller is a point lookup.
--
-- Why per-seller JSONB rather than a global event index: the lookup is
-- always "everything for this seller" and the row count per seller is
-- bounded (tens, not thousands). A single JSONB blob avoids per-row joins
-- on a hot panel-open path. Same reasoning as the FND table.
--
-- TTL: 30 min, matching foundationSellerListings. After 30 min a re-open
-- triggers a fresh scan; the route's pgCache (1h) collapses repeat opens
-- inside the TTL. The bulk-delist UI also calls
-- `/api/seller-listings/revalidate` immediately after a successful cancel
-- so the user sees the updated state without waiting for TTL expiry.

CREATE TABLE IF NOT EXISTS lazy_sr_seller_listings (
  seller            TEXT PRIMARY KEY,
  auctions          JSONB NOT NULL,
  last_indexed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
