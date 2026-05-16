-- Mint protocol moves into Ponder. After this migration:
--   - Mint artist-token discovery reads from `ponder_v*.mint_artist_tokens`
--     (populated by the new MintCollection handlers).
--   - The `known_artists` view reads Mint creators from
--     `ponder_v*.mint_creators` instead of the public.mint_creators table
--     that the web app maintained.
--
-- Drops what the web-side scan path used:
--   - public.mint_creators (replaced by ponder_v*.mint_creators)
--   - public.lazy_mint_artist_tokens
--   - public.lazy_mint_artist_status
--
-- Idempotent: DROP TABLE IF EXISTS / CREATE OR REPLACE VIEW.

-- Recreate `known_artists` first — has to drop the OLD reference to
-- public.mint_creators before we can DROP that table cleanly. Uses
-- the dynamic-schema detection introduced in migration 026.
DO $$
DECLARE
  ponder_schema         TEXT;
  has_catalog_contracts BOOLEAN;
  has_catalog_tokens    BOOLEAN;
  has_catalog_ranges    BOOLEAN;
  has_mint_creators     BOOLEAN;
  view_sql              TEXT;
BEGIN
  SELECT schemaname INTO ponder_schema
    FROM pg_tables
   WHERE tablename = 'pnd_houses'
     AND schemaname LIKE 'ponder%'
   ORDER BY schemaname DESC
   LIMIT 1;

  IF ponder_schema IS NULL THEN
    RAISE EXCEPTION 'no Ponder schema found (expected a `ponder*` schema with `pnd_houses`)';
  END IF;

  view_sql :=
    'CREATE OR REPLACE VIEW known_artists AS '                                ||
    'SELECT DISTINCT owner   AS address FROM ' || ponder_schema || '.pnd_houses '         ||
    'UNION '                                                                  ||
    'SELECT DISTINCT creator AS address FROM ' || ponder_schema || '.fnd_collections '    ||
    'UNION '                                                                  ||
    'SELECT DISTINCT creator AS address FROM ' || ponder_schema || '.fnd_artist_tokens';

  -- Mint creators now live in the Ponder schema. If the Ponder side
  -- hasn't backfilled yet (migration applied before the indexer
  -- redeploys with the new schema), the UNION harmlessly produces no
  -- rows — same effect as the previous public.mint_creators table
  -- being empty.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = ponder_schema AND table_name = 'mint_creators'
  ) INTO has_mint_creators;

  IF has_mint_creators THEN
    view_sql := view_sql || ' UNION SELECT DISTINCT address AS address FROM ' || ponder_schema || '.mint_creators';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = ponder_schema AND table_name = 'catalog_contracts'
  ) INTO has_catalog_contracts;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = ponder_schema AND table_name = 'catalog_tokens'
  ) INTO has_catalog_tokens;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = ponder_schema AND table_name = 'catalog_ranges'
  ) INTO has_catalog_ranges;

  IF has_catalog_contracts THEN
    view_sql := view_sql || ' UNION SELECT DISTINCT artist AS address FROM ' || ponder_schema || '.catalog_contracts';
  END IF;
  IF has_catalog_tokens THEN
    view_sql := view_sql || ' UNION SELECT DISTINCT artist AS address FROM ' || ponder_schema || '.catalog_tokens';
  END IF;
  IF has_catalog_ranges THEN
    view_sql := view_sql || ' UNION SELECT DISTINCT artist AS address FROM ' || ponder_schema || '.catalog_ranges';
  END IF;

  EXECUTE view_sql;
END $$;

-- Drop the now-unused web-side tables. The web app's mint.ts adapter
-- + lazy-index helpers + scan code that wrote these are removed in
-- the same PR as this migration.
DROP TABLE IF EXISTS mint_creators CASCADE;
DROP TABLE IF EXISTS lazy_mint_artist_tokens CASCADE;
DROP TABLE IF EXISTS lazy_mint_artist_status CASCADE;
