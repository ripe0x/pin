-- known_artists view: the single SPEND CEILING for the system. Every
-- worker scanner gates on this; addresses outside the set produce
-- zero external API spend regardless of traffic.
--
-- Membership rule: did this address take an explicit on-chain action
-- consistent with running their own artist infrastructure? We treat
-- "deployed your own contract" or "declared work in Catalog" as the
-- signal; passive mints on a shared marketplace contract are NOT
-- sufficient.
--
-- Earlier versions of this view included every srv2_artist_tokens
-- and fnd_artist_tokens creator (i.e. every mint on the shared 1/1
-- contracts). That ballooned the set to ~4,300 addresses — most of
-- whom were one-off SR minters from 2019 with no ongoing PND-relevant
-- activity. Worker scanners then spent capacity running per-artist
-- Manifold + active-auction scans for dormant addresses, mostly to
-- find nothing.
--
-- UNION sources (each one is a deliberate on-chain action):
--   1. PND house owners                (ponder_v*.pnd_houses.owner)
--   2. Foundation collection deployers (ponder_v*.fnd_collections.creator)
--   3. Mint factory deployers          (ponder_v*.mint_creators.address)
--   4. TL Universal Deployer senders   (ponder_v*.tl_creators.sender,
--                                       ERC721 only) — gated: included
--                                       ONLY if the same address also
--                                       has another ecosystem signal
--                                       below. Standalone TL deploys
--                                       are mostly test contracts and
--                                       abandoned attempts (1,503 of
--                                       1,530 raw senders). Cross-
--                                       platform deployers (27) are
--                                       real artists worth tracking.
--   5. Catalog declarants              (ponder_v*.catalog_{contracts,
--                                       tokens,ranges}.artist)
--   6. Manual seeds                    (public.artist_seeds.address)
--
-- Why this is safe: SR V2 shared-1/1 token data still surfaces on
-- /artist/[address] pages because the web app reads
-- ponder_v*.srv2_artist_tokens directly, not gated by known_artists.
-- Same for fnd_artist_tokens. Dropping those creators from the gate
-- only means the worker stops running scanners on their behalf
-- (Manifold contract discovery, per-artist active-auction tracking).
-- Those scanners were going to return empty for SR-only minters
-- anyway — by definition they have no other-platform activity.
--
-- New artists join automatically the moment they take any of the
-- gated actions above (e.g. deploy a PND house).
--
-- The Ponder schema name varies across versioned redeploys (ponder_v1,
-- ponder_v2, ...). This migration uses a runtime probe (find the schema
-- containing pnd_houses) so it adapts without manual editing on bumps.
--
-- Reads from this view are point lookups via the underlying tables'
-- own indexes. Postgres won't materialize the union for an EXISTS
-- check; each branch runs as its own index seek.

DO $$
DECLARE
  ponder_schema         TEXT;
  has_mint_creators     BOOLEAN;
  has_tl_creators       BOOLEAN;
  has_catalog_contracts BOOLEAN;
  has_catalog_tokens    BOOLEAN;
  has_catalog_ranges    BOOLEAN;
  view_sql              TEXT;
BEGIN
  -- Find the schema where Ponder writes pnd_houses. Adapts to schema
  -- version bumps without editing this migration.
  SELECT schemaname INTO ponder_schema
    FROM pg_tables
   WHERE tablename = 'pnd_houses'
     AND schemaname LIKE 'ponder%'
   ORDER BY schemaname DESC
   LIMIT 1;

  IF ponder_schema IS NULL THEN
    -- Bootstrap path: Ponder hasn't run yet on this database. Create
    -- a placeholder view backed only by `artist_seeds` so the worker
    -- can start. After Ponder backfills, RE-RUN THIS MIGRATION
    -- manually:
    --   psql $DATABASE_URL -f db/migrations/011_known_artists_view.sql
    -- The migration runner only applies each file once via
    -- _migrations, so the re-run has to be ad-hoc.
    RAISE NOTICE 'Ponder schema not found; creating bootstrap known_artists view (artist_seeds only). Re-run this migration after Ponder backfills.';
    EXECUTE 'CREATE OR REPLACE VIEW known_artists AS SELECT DISTINCT lower(address) AS address FROM public.artist_seeds';
    RETURN;
  END IF;

  -- Core sources — always present in v2's schema.
  view_sql :=
    'CREATE OR REPLACE VIEW known_artists AS '                                ||
    'SELECT DISTINCT lower(owner)   AS address FROM ' || ponder_schema || '.pnd_houses '         ||
    'UNION '                                                                  ||
    'SELECT DISTINCT lower(creator)        FROM ' || ponder_schema || '.fnd_collections '   ||
    'UNION '                                                                  ||
    'SELECT DISTINCT lower(address)        FROM public.artist_seeds';

  -- Optional sources — probe each to survive schema-rollout edge cases.
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = ponder_schema
                    AND table_name = 'mint_creators')
    INTO has_mint_creators;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = ponder_schema
                    AND table_name = 'tl_creators')
    INTO has_tl_creators;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = ponder_schema
                    AND table_name = 'catalog_contracts')
    INTO has_catalog_contracts;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = ponder_schema
                    AND table_name = 'catalog_tokens')
    INTO has_catalog_tokens;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = ponder_schema
                    AND table_name = 'catalog_ranges')
    INTO has_catalog_ranges;

  IF has_mint_creators THEN
    view_sql := view_sql ||
      ' UNION SELECT DISTINCT lower(address) FROM ' || ponder_schema || '.mint_creators';
  END IF;
  -- TL: ERC721 deployers ONLY if they also appear in another
  -- ecosystem source. Most raw TL deployers (1,503 of 1,530) are
  -- one-off test/abandoned contracts. The 27 that cross-deployed
  -- elsewhere are real artists. Filter at the source so the worker
  -- doesn't waste capacity per-artist-scanning ghost addresses.
  IF has_tl_creators THEN
    view_sql := view_sql ||
      ' UNION SELECT DISTINCT lower(t.sender) FROM ' || ponder_schema || '.tl_creators t' ||
      ' WHERE t.c_type LIKE ''ERC721%''' ||
      '   AND EXISTS (' ||
      '     SELECT 1 FROM ' || ponder_schema || '.pnd_houses    WHERE lower(owner)   = lower(t.sender)' ||
      '     UNION SELECT 1 FROM ' || ponder_schema || '.fnd_collections WHERE lower(creator) = lower(t.sender)' ||
      '     UNION SELECT 1 FROM ' || ponder_schema || '.mint_creators   WHERE lower(address) = lower(t.sender)' ||
      '     UNION SELECT 1 FROM ' || ponder_schema || '.catalog_contracts WHERE lower(artist) = lower(t.sender)' ||
      '     UNION SELECT 1 FROM ' || ponder_schema || '.catalog_tokens  WHERE lower(artist) = lower(t.sender)' ||
      '     UNION SELECT 1 FROM ' || ponder_schema || '.catalog_ranges  WHERE lower(artist) = lower(t.sender)' ||
      '     UNION SELECT 1 FROM public.artist_seeds              WHERE lower(address) = lower(t.sender)' ||
      '   )';
  END IF;
  IF has_catalog_contracts THEN
    view_sql := view_sql ||
      ' UNION SELECT DISTINCT lower(artist)  FROM ' || ponder_schema || '.catalog_contracts';
  END IF;
  IF has_catalog_tokens THEN
    view_sql := view_sql ||
      ' UNION SELECT DISTINCT lower(artist)  FROM ' || ponder_schema || '.catalog_tokens';
  END IF;
  IF has_catalog_ranges THEN
    view_sql := view_sql ||
      ' UNION SELECT DISTINCT lower(artist)  FROM ' || ponder_schema || '.catalog_ranges';
  END IF;

  EXECUTE view_sql;
END $$;
