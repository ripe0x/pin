-- ERC-1155 per-token stats. Worker-owned (writer: scan-1155-stats task).
--
-- Why a separate table: token_owners is one-row-per-token (contract,
-- token_id → owner), which works for ERC-721 but not ERC-1155 where
-- many wallets hold copies of the same tokenId. Tracking the full
-- (contract, token_id, owner, amount) matrix would be a much bigger
-- schema. Instead this table stores only the aggregates the UI needs:
-- total supply + distinct owner count.
--
-- Populated by Alchemy NFT API on a slow loop. Cached forever per
-- (contract, tokenId); only re-fetched on TTL expiry when totalSupply
-- or ownerCount has plausibly changed (1155 editions can mint over time).

CREATE TABLE IF NOT EXISTS token_1155_stats (
  contract       TEXT NOT NULL,
  token_id       TEXT NOT NULL,
  total_supply   TEXT NOT NULL,
  owner_count    INTEGER NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);

CREATE INDEX IF NOT EXISTS token_1155_stats_fetched_at_idx
  ON token_1155_stats (fetched_at);
