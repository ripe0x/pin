-- collection_media: captured static media for PND Collection System
-- tokens (contracts/src/collection/), written by the worker's
-- capture-collection-media task.
--
-- Scope (v1): SVG-only. When a token's renderer JSON `image` field is a
-- `data:image/svg+xml` URI (inline, base64 or utf8), the task rasterizes
-- it server-side with `sharp` to a 1200px PNG and stores the bytes here.
--
-- Storage precedent: everything else in this schema (token_metadata,
-- fnd_collections_seed, etc.) stores media as a TEXT url/data-URI, never
-- raw bytes — there is no blob-storage/CDN layer in this repo to defer
-- to. A rasterized PNG has no such URI to point at (it doesn't exist
-- until we render it), so it's stored directly as `bytea`, the smallest
-- addition consistent with "Postgres is the only store" used elsewhere
-- (cache_entries, token_metadata). Revisit if row size becomes an
-- operational problem (Railway Postgres, not S3/R2) — the `kind`/`status`
-- split below makes it cheap to swap the `png` column for a
-- `storage_path` TEXT column later without changing the row shape.
--
-- `kind` distinguishes the capture path (only 'svg' is implemented in
-- v1); `status` distinguishes a completed capture from a token that
-- still needs one:
--   'ready'              — `png` holds a rasterized image.
--   'needs_html_capture' — the token's canonical view is animation_url
--                          HTML with no SVG image fallback; no headless
--                          browser in the worker image yet (open infra
--                          decision — see docs/pnd-collection-web-plan.md
--                          D7). Row is a placeholder so the scan loop
--                          doesn't re-attempt every tick.
--   'failed'             — attempted and gave up (bad data URI, sharp
--                          rasterize error, etc.); retried after
--                          RETRY_AFTER like token_metadata's empty rows.
--
-- A row exists iff a capture was ever attempted, mirroring
-- token_metadata's "row presence = attempted" convention.

CREATE TABLE IF NOT EXISTS collection_media (
  collection    TEXT NOT NULL,          -- lowercase SovereignCollection address
  token_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- 'svg' | 'html' (capture path)
  status        TEXT NOT NULL,          -- 'ready' | 'needs_html_capture' | 'failed'
  png           BYTEA,                  -- rasterized 1200px PNG bytes (kind='svg', status='ready')
  width         INTEGER,
  error         TEXT,                   -- last failure reason, if status='failed'
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, token_id)
);

CREATE INDEX IF NOT EXISTS collection_media_status_idx
  ON collection_media (status);

CREATE INDEX IF NOT EXISTS collection_media_captured_at_idx
  ON collection_media (captured_at);
