-- Persistent token metadata. Replaces the `token-metadata:*` keys in
-- `cache_entries`, which had a 1h TTL and forced a tokenURI eth_call +
-- IPFS/HTTP fetch on every expiry. Token metadata at a (contract, tokenId)
-- pair is effectively immutable for ~99% of NFTs (IPFS-pinned URIs are
-- content-addressed; on-chain renderers vary deterministically with input
-- args). Treating it as a permanent index instead of a cache eliminates
-- repeated upstream fetches.
--
-- Row contract: a row exists iff we've ever attempted resolution for this
-- (contract, tokenId). All metadata columns are nullable: a row with
-- name=NULL, image_url=NULL, raw_uri=NULL means "we tried, the contract
-- reverted or returned nothing useful" — store it anyway so we don't
-- re-attempt on the next read. Distinguish from "never fetched" by row
-- presence.
--
-- Re-fetch policy: by default, never. If the rare mutable-metadata case
-- becomes a problem we can add a periodic background sweep that
-- re-resolves rows older than N days. fetched_at supports that without
-- requiring a schema change.

CREATE TABLE IF NOT EXISTS token_metadata (
  contract     TEXT NOT NULL,
  token_id     TEXT NOT NULL,
  name         TEXT,
  description  TEXT,
  image_url    TEXT,
  raw_uri      TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);

-- Supports the optional "re-fetch entries older than N days" sweep without
-- a full table scan.
CREATE INDEX IF NOT EXISTS token_metadata_fetched_at_idx
  ON token_metadata (fetched_at);
