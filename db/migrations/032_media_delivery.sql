-- Durable delivery state for external token media.
--
-- Canonical token media stays at its original URI. This table stores only
-- probe results and CDN/object-storage derivative pointers. Binary derivatives
-- never belong in Postgres. `collection_media.png` is retained temporarily as
-- a bounded rollout fallback for rows created by migration 025's retired
-- Surface SVG task; no current worker writes it.

CREATE TABLE IF NOT EXISTS token_media_delivery (
  contract          TEXT NOT NULL,
  token_id          TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  resolved_url      TEXT,
  source_path       TEXT,
  media_kind        TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (media_kind IN ('image', 'video', 'animation', 'unknown')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'ready', 'unsupported', 'failed')),
  thumbnail_url     TEXT,
  poster_url        TEXT,
  width             INTEGER CHECK (width IS NULL OR width > 0),
  height            INTEGER CHECK (height IS NULL OR height > 0),
  duration_ms       BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  mime_type         TEXT,
  source_bytes      BIGINT CHECK (source_bytes IS NULL OR source_bytes >= 0),
  derivative_bytes  BIGINT CHECK (derivative_bytes IS NULL OR derivative_bytes >= 0),
  source_sha256     TEXT CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  derivative_sha256 TEXT CHECK (derivative_sha256 IS NULL OR derivative_sha256 ~ '^[0-9a-f]{64}$'),
  preferred_gateway TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at   TIMESTAMPTZ,
  last_success_at   TIMESTAMPTZ,
  next_attempt_at   TIMESTAMPTZ,
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id),
  CHECK (
    status <> 'ready'
    OR thumbnail_url IS NOT NULL
    OR poster_url IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS token_media_delivery_retry_idx
  ON token_media_delivery (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS token_media_delivery_source_idx
  ON token_media_delivery (source_url, status);

CREATE INDEX IF NOT EXISTS token_media_delivery_source_hash_idx
  ON token_media_delivery (source_sha256)
  WHERE source_sha256 IS NOT NULL;

-- Normalize migration 025's legacy Surface states and add enough metadata to
-- migrate already-captured rows out of Postgres later. Surface capture itself
-- remains owned by RenderAssets and issues #271/#272, not this cache pipeline.
UPDATE collection_media
SET status = 'unsupported'
WHERE status = 'needs_html_capture';

ALTER TABLE collection_media
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS poster_url TEXT,
  ADD COLUMN IF NOT EXISTS height INTEGER,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS byte_size BIGINT,
  ADD COLUMN IF NOT EXISTS sha256 TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

UPDATE collection_media
SET byte_size = COALESCE(byte_size, octet_length(png)),
    mime_type = COALESCE(mime_type, CASE WHEN png IS NOT NULL THEN 'image/png' END),
    last_success_at = COALESCE(
      last_success_at,
      CASE WHEN status = 'ready' THEN captured_at END
    ),
    last_error = COALESCE(last_error, error)
WHERE png IS NOT NULL OR error IS NOT NULL;
