-- token_owners: current owner per indexed token. One row per token,
-- overwritten on every transfer. Worker-owned (writer: scan-token-transfers,
-- plus event-triggered resolve-new-token-owner for fresh mints).
--
-- The `INDEX (owner)` is the load-bearing optimization for the
-- /collector/[address] inverse query. Without this index, "what does
-- this wallet currently own" requires a full table scan; with it, it's
-- a point lookup. This single index is why /collector pages can be
-- served from Postgres instead of Alchemy NFT API.
--
-- The `transferred_at_block` UPSERT guard (in scan-token-transfers)
-- prevents a stale log catching up out-of-order from overwriting a
-- newer ownership update. Ponder is monotonic, but the worker scans
-- can land in any order across contracts; the guard makes the writes
-- commutative.

CREATE TABLE IF NOT EXISTS token_owners (
  contract             TEXT NOT NULL,
  token_id             TEXT NOT NULL,
  owner                TEXT NOT NULL,
  transferred_at_block BIGINT NOT NULL,
  transferred_at_time  BIGINT NOT NULL,
  tx_hash              TEXT,
  PRIMARY KEY (contract, token_id)
);

CREATE INDEX IF NOT EXISTS token_owners_owner_idx
  ON token_owners (owner);
