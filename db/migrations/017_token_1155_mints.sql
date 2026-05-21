-- ERC-1155 mint history. Worker-owned (writer: scan-mint-clones via
-- scanErc1155MintsFromZero). One row per mint event — a TransferSingle, or
-- one id of an expanded TransferBatch, with from = 0x0.
--
-- Feeds two things the token detail page needs and that token_1155_stats
-- alone couldn't provide:
--   - total_supply: Σ(amount) per (contract, token_id), written to
--     token_1155_stats by scan-1155-stats. The on-chain totalSupply(id)
--     reverts on Mint protocol contracts (no ERC1155Supply), so supply has
--     to be derived from the mint events the scanner already fetches.
--   - mint-history provenance: the per-edition mint timeline.
--
-- We deliberately track only mints (from = 0x0), not secondary transfers:
-- that covers "total count" + mint history, and scanning every transfer to
-- maintain a full balance ledger would multiply RPC cost with no UI payoff.
-- Distinct holder count therefore stays deferred (token_1155_stats.owner_count
-- remains 0 / "—").

CREATE TABLE IF NOT EXISTS token_1155_mints (
  contract      TEXT    NOT NULL,
  token_id      TEXT    NOT NULL,
  to_addr       TEXT    NOT NULL,
  amount        TEXT    NOT NULL,         -- minted value (uint256 as text)
  block_number  BIGINT  NOT NULL,
  block_time    BIGINT,                   -- unix seconds; null until resolved
  tx_hash       TEXT    NOT NULL,
  log_index     INTEGER NOT NULL,
  -- A TransferBatch mints several ids in one (tx_hash, log_index); token_id
  -- disambiguates those rows so the primary key stays unique.
  PRIMARY KEY (tx_hash, log_index, token_id)
);

CREATE INDEX IF NOT EXISTS token_1155_mints_token_idx
  ON token_1155_mints (contract, token_id, block_number DESC);
