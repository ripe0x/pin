-- token_metadata: tokenURI + IPFS-resolved JSON per token. Worker-owned
-- (writer: warm-metadata, formerly metadata-warmer service).
--
-- A row exists iff we've ever attempted resolution. All payload columns
-- are nullable — a row with all-null payload is "we tried, the contract
-- reverted or returned nothing useful." Distinguish from "never fetched"
-- by row presence.
--
-- Re-resolve policy: by default, never. The warm-metadata task re-tries
-- all-null rows older than RETRY_AFTER (7 days) since IPFS pinning
-- sometimes recovers stale pins.

CREATE TABLE IF NOT EXISTS token_metadata (
  contract       TEXT NOT NULL,
  token_id       TEXT NOT NULL,
  name           TEXT,
  description    TEXT,
  image_url      TEXT,
  animation_url  TEXT,
  raw_uri        TEXT,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);

CREATE INDEX IF NOT EXISTS token_metadata_fetched_at_idx
  ON token_metadata (fetched_at);
