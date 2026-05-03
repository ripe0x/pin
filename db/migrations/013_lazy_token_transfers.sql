-- Per-token ERC-721 transfer history index. Mirrors the lazy_*_bids
-- pattern: cursor-bounded incremental scan + persistent rows so
-- repeat token-page renders skip the full deploy-to-head log scan
-- that getTokenOnChainData was doing on every cache miss.
--
-- Read path (in apps/web/src/lib/onchain-discovery.ts):
--   1. Read cached transfer rows for (contract, tokenId).
--   2. Read cursor (last_block) for the same key from
--      lazy_scan_cursors with key 'token-transfers:<contract>:<tokenId>'.
--   3. Scan eth_getLogs from [cursor + 1, latest] (or from contract
--      deploy block if no cursor exists).
--   4. UPSERT new transfers; advance cursor; return cached + new
--      merged.
--
-- Without persistence the cursor would shrink the scan range but
-- discard the historical transfers a cold render needs to display
-- the provenance timeline. With persistence the first cold render
-- pays the full deploy-to-head scan once; every subsequent miss is
-- bounded by the elapsed time since the last visit.

CREATE TABLE IF NOT EXISTS lazy_token_transfers (
  contract     TEXT    NOT NULL,
  token_id     TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  from_addr    TEXT    NOT NULL,
  to_addr      TEXT    NOT NULL,
  block_number BIGINT  NOT NULL,
  block_time   BIGINT  NOT NULL,
  PRIMARY KEY (contract, token_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS lazy_token_transfers_token_idx
  ON lazy_token_transfers (contract, token_id, block_number DESC, log_index DESC);
