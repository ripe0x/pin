-- `known_artists` view defines the set of addresses the app treats as
-- "real artists in our ecosystem." It is the single gate that bounds
-- external-platform indexing cost (Manifold / SR V2 / TL) — anonymous
-- crawler traffic against `/artist/<address>` for addresses outside this
-- set produces zero Alchemy spend because the adapter declines to call
-- external APIs for unknown addresses.
--
-- Membership criteria (any of these counts as "known"):
--   1. Deployed a Sovereign Auction House (pnd_houses.owner)
--   2. Deployed a Foundation collection contract (fnd_collections.creator)
--   3. Minted a Foundation token, on the shared 1/1 contract or their own
--      collection (fnd_artist_tokens.creator)
--   4. Declared work in the on-chain Catalog (catalog_contracts.artist
--      ∪ catalog_tokens.artist ∪ catalog_ranges.artist) — included
--      only when those Ponder tables actually exist in production.
--      Catalog support is a newer Ponder schema addition; if the
--      deployed indexer predates it, the catalog branches are omitted
--      gracefully. Re-run this migration (or add a follow-up) after
--      deploying the catalog-aware Ponder schema to pick them up.
--
-- Reads from this view are point lookups via the unique (address) on the
-- underlying tables. Postgres won't materialize the union for an EXISTS
-- check; each branch runs as its own index seek.
--
-- All addresses are lower-cased by Ponder when written, so the view does
-- not need a LOWER() call. Callers should also lowercase before lookup.
--
-- Future-extensible: when manual opt-in lands (see
-- apps/web/src/lib/external-indexer.ts header), UNION a `manual_opt_ins`
-- table into this view — no downstream code changes needed.

DO $$
DECLARE
  has_catalog_contracts BOOLEAN;
  has_catalog_tokens    BOOLEAN;
  has_catalog_ranges    BOOLEAN;
  view_sql TEXT;
BEGIN
  -- Core sources — these MUST exist; Ponder writes them as part of
  -- the FND/PND schemas that the rest of the app already depends on.
  view_sql :=
    'CREATE OR REPLACE VIEW known_artists AS '                          ||
    'SELECT DISTINCT owner   AS address FROM ponder.pnd_houses '        ||
    'UNION '                                                            ||
    'SELECT DISTINCT creator AS address FROM ponder.fnd_collections '   ||
    'UNION '                                                            ||
    'SELECT DISTINCT creator AS address FROM ponder.fnd_artist_tokens';

  -- Optional sources — newer Ponder schema. Probe each separately
  -- so a partial rollout (one table exists but the others don't)
  -- still produces a working view.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'ponder' AND table_name = 'catalog_contracts'
  ) INTO has_catalog_contracts;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'ponder' AND table_name = 'catalog_tokens'
  ) INTO has_catalog_tokens;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'ponder' AND table_name = 'catalog_ranges'
  ) INTO has_catalog_ranges;

  IF has_catalog_contracts THEN
    view_sql := view_sql || ' UNION SELECT DISTINCT artist AS address FROM ponder.catalog_contracts';
  END IF;
  IF has_catalog_tokens THEN
    view_sql := view_sql || ' UNION SELECT DISTINCT artist AS address FROM ponder.catalog_tokens';
  END IF;
  IF has_catalog_ranges THEN
    view_sql := view_sql || ' UNION SELECT DISTINCT artist AS address FROM ponder.catalog_ranges';
  END IF;

  EXECUTE view_sql;
END $$;
