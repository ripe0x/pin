-- Foundation cancellable-listings seed (discovery side of /delist).
--
-- Replaces apps/web/src/data/fnd-cancellable.json. The JSON seed was built
-- from the v1 lazy-index snapshot, which only ingested auctions that PND
-- page-views had touched — a full-history on-chain scan (see
-- scripts/scan-fnd-active-auctions.mjs) found ~174k live reserve auctions
-- vs the snapshot's 13.5k. At that size the bundled-JSON design taxes every
-- lambda cold start (~33MB parse held resident), so the seed moves to
-- Postgres per the repo rule that web reads come from Postgres.
--
-- Discovery/verification split is unchanged: this table answers "what
-- COULD seller X still have open" (frozen set — Foundation stopped
-- accepting listings in late 2025); getCancellableListingsForSeller
-- re-verifies every candidate on-chain per request, so stale rows are
-- harmless. Data is loaded by scripts/scan-fnd-active-auctions.mjs (CSV +
-- \copy), not by this migration.
--
-- NOTE: applied to maglev directly via psql on 2026-06-11 (not via
-- db:migrate, to keep the flagged 016 reconciliation a deliberate act).
-- IF NOT EXISTS keeps the eventual db:migrate replay a no-op.

CREATE TABLE IF NOT EXISTS public.fnd_cancellable_listings (
  id text PRIMARY KEY,         -- 'a:<auctionId>' | 'b:<contract>-<tokenId>'
  seller text NOT NULL,        -- lowercase 0x address
  kind text NOT NULL CHECK (kind IN ('auction', 'buyNow')),
  auction_id text,             -- auctions only
  contract text NOT NULL,      -- lowercase 0x address
  token_id text NOT NULL,
  price_wei text NOT NULL      -- reserve price (auction) or list price (buyNow)
);

CREATE INDEX IF NOT EXISTS fnd_cancellable_listings_seller_idx
  ON public.fnd_cancellable_listings (seller);
