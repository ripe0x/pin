-- Stable read alias and cutover state for versioned Ponder schemas.
--
-- Ponder must keep writing to versioned schemas (ponder_v2, ponder_v3, ...)
-- so a replacement index can backfill without disturbing the live one. Web
-- and worker readers should target indexer_live instead. The cutover script
-- validates a completed target and atomically repoints every alias view.

CREATE SCHEMA IF NOT EXISTS indexer_live;

CREATE TABLE IF NOT EXISTS public.indexer_state (
  singleton       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  active_schema   TEXT CHECK (
    active_schema IS NULL OR active_schema ~ '^ponder_v[0-9]+$'
  ),
  previous_schema TEXT CHECK (
    previous_schema IS NULL OR previous_schema ~ '^ponder_v[0-9]+$'
  ),
  build_id        TEXT,
  table_counts    JSONB NOT NULL DEFAULT '{}'::jsonb,
  switched_at     TIMESTAMPTZ,
  switched_by     TEXT
);

INSERT INTO public.indexer_state (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- A rollback compares the target with the snapshot captured when that schema
-- was last live. This prevents an old schema that lost rows after cutover from
-- being selected merely because an operator requested a rollback.
CREATE TABLE IF NOT EXISTS public.indexer_schema_snapshots (
  schema_name  TEXT PRIMARY KEY CHECK (schema_name ~ '^ponder_v[0-9]+$'),
  build_id     TEXT NOT NULL,
  table_counts JSONB NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
