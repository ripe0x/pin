-- Add tx-hash columns to the Ponder-managed PND tables so the activity
-- feed can render "view tx" links for house deployments, auction
-- creations, settlements, and cancellations.
--
-- These are normally Ponder's responsibility (they're declared in
-- `ponder/ponder.schema.ts`), but Ponder requires a re-sync to
-- materialize new schema columns and that's an operationally-expensive
-- step. ALTER ... ADD COLUMN IF NOT EXISTS lets the web app deploy
-- ahead of the Ponder re-sync without breaking the activity feed —
-- existing rows stay NULL until backfilled, new events from a
-- re-deployed indexer write the value going forward.
--
-- Idempotent: safe to run before or after Ponder re-syncs. If Ponder's
-- own schema migration runs first, these statements are no-ops.

ALTER TABLE ponder.pnd_houses
  ADD COLUMN IF NOT EXISTS created_tx_hash TEXT;

ALTER TABLE ponder.pnd_auctions
  ADD COLUMN IF NOT EXISTS created_tx_hash TEXT;

ALTER TABLE ponder.pnd_auctions
  ADD COLUMN IF NOT EXISTS lifecycle_tx_hash TEXT;
