-- token_transfers: append-only provenance log per indexed token. Powers
-- the token detail page's provenance section.
--
-- Worker-owned (writer: scan-token-transfers). Same first-time backfill
-- optimization as token_owners — cursor starts at MIN(mint_block) FROM
-- artist_tokens WHERE contract=$1 instead of contract deploy block,
-- bounding the scan to tokens we actually care about.
--
-- PK (contract, token_id, tx_hash, log_index) makes inserts idempotent:
-- re-orgs that re-emit a Transfer hit ON CONFLICT DO NOTHING and the
-- row stays exactly once.

CREATE TABLE IF NOT EXISTS token_transfers (
  contract     TEXT    NOT NULL,
  token_id     TEXT    NOT NULL,
  from_addr    TEXT    NOT NULL,
  to_addr      TEXT    NOT NULL,
  block_number BIGINT  NOT NULL,
  log_index    INTEGER NOT NULL,
  tx_hash      TEXT    NOT NULL,
  block_time   BIGINT  NOT NULL,
  PRIMARY KEY (contract, token_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS token_transfers_token_idx
  ON token_transfers (contract, token_id, block_number DESC, log_index DESC);
