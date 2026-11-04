-- known_artists: rebuildable against an explicit Ponder schema (#295).
--
-- Migration 011 built the known_artists view (the worker's spend ceiling)
-- against whichever `ponder*` schema containing pnd_houses sorted last
-- lexically AT THE TIME IT RAN, then baked that schema name into the
-- view. The runner never re-applies a file, so every later indexer
-- cutover (ponder_v2 -> v3 -> v4) left the view reading the old schema:
-- artists who joined after that schema froze (new PND house owners, FND
-- collection deployers, Mint creators, Catalog declarants) never enter
-- the set, so no worker scanner runs for them, with no error. The
-- lexical sort would also pick ponder_v9 over ponder_v10.
--
-- This migration does NOT rebuild the view and does NOT pick a schema.
-- It only adds two functions:
--
--   pnd_rebuild_known_artists(target_schema text) RETURNS text
--     Recreates public.known_artists with 011's exact membership rule
--     against `target_schema` (identifiers quoted with format('%I')).
--     Raises, leaving the current view untouched, if the schema does not
--     exist or lacks the two core tables. Returns the schema it used.
--
--   pnd_known_artists_schema() RETURNS text
--     The Ponder schema(s) the view currently reads, derived from the
--     view's own dependency rows in pg_depend (so it also works for the
--     view 011 created). NULL for the bootstrap seeds-only view or a
--     missing view; comma-joined if the view somehow spans schemas.
--
-- The worker calls the pair on startup (apps/worker/src/
-- startup-checks.ts): if the view's schema differs from
-- INDEXER_SCHEMA it rebuilds against INDEXER_SCHEMA. A cutover can also
-- run it by hand, see docs/ponder-schema-cutover.md:
--   SELECT pnd_known_artists_schema();
--   SELECT pnd_rebuild_known_artists('ponder_v4');
--
-- Membership rule (unchanged from 011; see its header for the why):
--   1. PND house owners                (pnd_houses.owner)
--   2. Foundation collection deployers (fnd_collections.creator)
--   3. Mint factory deployers          (mint_creators.address)
--   4. TL ERC721 deployers             (tl_creators.sender) ONLY if the
--      same address has another signal from this list
--   5. Catalog declarants              (catalog_{contracts,tokens,ranges}.artist)
--   6. Manual seeds                    (public.artist_seeds.address)
-- Tables 3-5 are optional (included when present), as in 011. The frozen
-- FND discovery seeds from 023 are deliberately NOT members (see 023).

CREATE OR REPLACE FUNCTION public.pnd_rebuild_known_artists(target_schema text)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  s                     text := target_schema;
  has_mint_creators     boolean;
  has_tl_creators       boolean;
  has_catalog_contracts boolean;
  has_catalog_tokens    boolean;
  has_catalog_ranges    boolean;
  view_sql              text;
  tl_signal             text;
BEGIN
  IF s IS NULL OR s = '' THEN
    RAISE EXCEPTION 'pnd_rebuild_known_artists: target_schema is empty';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
    RAISE EXCEPTION 'pnd_rebuild_known_artists: schema % does not exist', s;
  END IF;
  IF to_regclass(format('%I.%I', s, 'pnd_houses')) IS NULL
     OR to_regclass(format('%I.%I', s, 'fnd_collections')) IS NULL THEN
    RAISE EXCEPTION
      'pnd_rebuild_known_artists: schema % has no pnd_houses/fnd_collections (has Ponder finished creating it?); view left unchanged', s;
  END IF;

  -- One rebuild at a time (two workers booting together, or a manual
  -- run racing the worker). Released at transaction end.
  PERFORM pg_advisory_xact_lock(hashtext('pnd_rebuild_known_artists'));

  has_mint_creators     := to_regclass(format('%I.%I', s, 'mint_creators'))     IS NOT NULL;
  has_tl_creators       := to_regclass(format('%I.%I', s, 'tl_creators'))       IS NOT NULL;
  has_catalog_contracts := to_regclass(format('%I.%I', s, 'catalog_contracts')) IS NOT NULL;
  has_catalog_tokens    := to_regclass(format('%I.%I', s, 'catalog_tokens'))    IS NOT NULL;
  has_catalog_ranges    := to_regclass(format('%I.%I', s, 'catalog_ranges'))    IS NOT NULL;

  -- Core sources.
  view_sql :=
       format('SELECT DISTINCT lower(owner) AS address FROM %I.pnd_houses', s)
    || format(' UNION SELECT DISTINCT lower(creator) FROM %I.fnd_collections', s)
    || ' UNION SELECT DISTINCT lower(address) FROM public.artist_seeds';

  IF has_mint_creators THEN
    view_sql := view_sql
      || format(' UNION SELECT DISTINCT lower(address) FROM %I.mint_creators', s);
  END IF;

  -- TL: ERC721 deployers only when they also carry another ecosystem
  -- signal (011's gate). Only signal tables that exist are referenced.
  IF has_tl_creators THEN
    tl_signal :=
         format('SELECT 1 FROM %I.pnd_houses WHERE lower(owner) = lower(t.sender)', s)
      || format(' UNION SELECT 1 FROM %I.fnd_collections WHERE lower(creator) = lower(t.sender)', s);
    IF has_mint_creators THEN
      tl_signal := tl_signal
        || format(' UNION SELECT 1 FROM %I.mint_creators WHERE lower(address) = lower(t.sender)', s);
    END IF;
    IF has_catalog_contracts THEN
      tl_signal := tl_signal
        || format(' UNION SELECT 1 FROM %I.catalog_contracts WHERE lower(artist) = lower(t.sender)', s);
    END IF;
    IF has_catalog_tokens THEN
      tl_signal := tl_signal
        || format(' UNION SELECT 1 FROM %I.catalog_tokens WHERE lower(artist) = lower(t.sender)', s);
    END IF;
    IF has_catalog_ranges THEN
      tl_signal := tl_signal
        || format(' UNION SELECT 1 FROM %I.catalog_ranges WHERE lower(artist) = lower(t.sender)', s);
    END IF;
    tl_signal := tl_signal
      || ' UNION SELECT 1 FROM public.artist_seeds WHERE lower(address) = lower(t.sender)';

    view_sql := view_sql
      || format(' UNION SELECT DISTINCT lower(t.sender) FROM %I.tl_creators t', s)
      || format(' WHERE t.c_type LIKE %L AND EXISTS (', 'ERC721%')
      || tl_signal || ')';
  END IF;

  IF has_catalog_contracts THEN
    view_sql := view_sql
      || format(' UNION SELECT DISTINCT lower(artist) FROM %I.catalog_contracts', s);
  END IF;
  IF has_catalog_tokens THEN
    view_sql := view_sql
      || format(' UNION SELECT DISTINCT lower(artist) FROM %I.catalog_tokens', s);
  END IF;
  IF has_catalog_ranges THEN
    view_sql := view_sql
      || format(' UNION SELECT DISTINCT lower(artist) FROM %I.catalog_ranges', s);
  END IF;

  -- Same name, same single `address text` column as 011, so dependents
  -- survive CREATE OR REPLACE.
  EXECUTE 'CREATE OR REPLACE VIEW public.known_artists AS ' || view_sql;
  EXECUTE format(
    'COMMENT ON VIEW public.known_artists IS %L',
    format('Worker spend ceiling. Built by pnd_rebuild_known_artists(%L) at %s.', s, now())
  );

  RETURN s;
END
$fn$;

CREATE OR REPLACE FUNCTION public.pnd_known_artists_schema()
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT string_agg(DISTINCT n.nspname::text, ',' ORDER BY n.nspname::text)
  FROM pg_rewrite r
  JOIN pg_depend d
    ON d.classid = 'pg_rewrite'::regclass
   AND d.objid = r.oid
   AND d.refclassid = 'pg_class'::regclass
  JOIN pg_class c ON c.oid = d.refobjid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE r.ev_class = to_regclass('public.known_artists')
    AND c.oid <> r.ev_class
    AND n.nspname <> 'public'
$fn$;
