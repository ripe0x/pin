-- Add `creator` column to the SR V2 and TL active-auction tables so
-- the home-grid orchestrator can filter to "artist-seller" auctions
-- (where the listing's seller is the original token creator) and
-- drop secondary listings (collector reselling someone else's work).
--
-- Nullable because the scanner backfills it via tokenCreator() reads
-- (or contract.owner() fallback for TL contracts that don't implement
-- the SR creator interface). Rows with creator=null are pre-backfill
-- — the read path treats them as "unverified" and excludes them from
-- the home grid; the next scanner pass fills them in.
--
-- PND/Sovereign auctions are always primary by construction (each
-- house only auctions the artist's own work), so no migration needed
-- there.

ALTER TABLE lazy_srv2_active_auctions
  ADD COLUMN IF NOT EXISTS creator TEXT;
CREATE INDEX IF NOT EXISTS lazy_srv2_active_auctions_creator_idx
  ON lazy_srv2_active_auctions (status, creator) WHERE status = 'active';

ALTER TABLE lazy_tl_active_auctions
  ADD COLUMN IF NOT EXISTS creator TEXT;
CREATE INDEX IF NOT EXISTS lazy_tl_active_auctions_creator_idx
  ON lazy_tl_active_auctions (status, creator) WHERE status = 'active';
