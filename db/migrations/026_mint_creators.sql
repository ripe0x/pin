-- `mint_creators` extends the `known_artists` allow-list with every
-- address that has deployed a Mint protocol (Visualize Value) collection
-- contract.
--
-- Population: maintained incrementally by `refreshMintCreators` in
-- `apps/web/src/lib/platforms/mint.ts`, which is called at the top of
-- the daily `/api/cron/refresh-external-indexes` run. The function uses
-- `MAX(first_seen_block)` as its cursor, so on first run it backfills
-- from `MINT_FACTORY_DEPLOY_BLOCK` (21167599); on subsequent runs it
-- only scans new Factory blocks.
--
-- Why include `first_seen_block`: lets the cron resume without a
-- separate cursor table, and gives us a "joined the Mint ecosystem on"
-- timestamp for diagnostics. The Factory's `Created` event carries the
-- block number directly.

CREATE TABLE IF NOT EXISTS mint_creators (
  address           TEXT PRIMARY KEY,
  first_seen_block  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mint_creators_first_seen_idx
  ON mint_creators (first_seen_block);

-- Recreate the `known_artists` view with `mint_creators` UNION'd in.
--
-- Ponder versions its schema name across redeploys (e.g. `ponder` →
-- `ponder_v1` → `ponder_v2`). The migration probes pg_tables for
-- whichever schema currently exposes `pnd_houses` so it doesn't bind
-- to a stale name; the production view was already deployed pointing
-- at `ponder_v1` after a Ponder redeploy that migration 022 didn't
-- anticipate.
--
-- Also probes the optional `catalog_*` tables (added in a newer
-- Ponder schema) so a partial rollout still produces a working view —
-- same pattern as migration 022.

DO $$
DECLARE
  ponder_schema         TEXT;
  has_catalog_contracts BOOLEAN;
  has_catalog_tokens    BOOLEAN;
  has_catalog_ranges    BOOLEAN;
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
    'SELECT DISTINCT creator AS address FROM ' || ponder_schema || '.fnd_artist_tokens '  ||
    'UNION '                                                                  ||
    'SELECT address FROM mint_creators';

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
