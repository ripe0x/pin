-- Foundation discovery seeds: pre-indexer-window contract + shared-mint
-- discovery, completing what Ponder watches live from FND_START_BLOCK
-- (~Oct 2025) onward.
--
-- Why: ponder_v1.fnd_collections only sees factory deploys after the
-- indexer's start block (2 rows vs ~thousands of historical collections),
-- and the worker's scan-fnd-shared sweep filters Minted events by
-- known_artists AT SCAN TIME — an artist admitted after the sweep passed
-- their mint blocks never gets their historical shared 1/1s. Both gaps
-- made newly admitted artists (e.g. via artist_seeds) render empty
-- profiles even though their works are trivially discoverable onchain.
--
-- These tables are frozen full-history seeds (the past doesn't change);
-- Ponder + the worker's cursor sweeps own everything after their start
-- blocks. Data loaded by scripts/scan-fnd-discovery-seeds.mjs via \copy.
--
-- Deliberately NOT unioned into the known_artists view: historical
-- collection deployers are not auto-admitted (that would put ~every FND
-- artist ever inside the worker's spend ceiling). The seeds only answer
-- "what did artist X make" for artists already admitted.
--
-- NOTE: applied to maglev directly via psql (not db:migrate — keeps the
-- flagged 016 reconciliation a deliberate act). IF NOT EXISTS makes the
-- eventual db:migrate replay a no-op.

CREATE TABLE IF NOT EXISTS public.fnd_collections_seed (
  collection text PRIMARY KEY,   -- lowercase clone address
  creator text NOT NULL,         -- lowercase artist address
  deploy_block bigint NOT NULL,
  tx_hash text
);

CREATE INDEX IF NOT EXISTS fnd_collections_seed_creator_idx
  ON public.fnd_collections_seed (creator);

CREATE TABLE IF NOT EXISTS public.fnd_shared_mints_seed (
  token_id text PRIMARY KEY,
  creator text NOT NULL,         -- lowercase artist address
  mint_block bigint NOT NULL,
  mint_log_index integer NOT NULL,
  tx_hash text
);

CREATE INDEX IF NOT EXISTS fnd_shared_mints_seed_creator_idx
  ON public.fnd_shared_mints_seed (creator);
