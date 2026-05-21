-- manifold_contracts: per-artist Manifold contract classification cache.
-- Used by the worker's scan-manifold task. Without this, every refresh
-- re-runs `supportsInterface(0x28f10a21)` against every contract the
-- artist has ever deployed via Etherscan txlist — the classification
-- multicall is the expensive part. With this cache, classification is
-- one multicall per (artist, contract) ever, and re-classification
-- happens only when an artist deploys new contracts.
--
-- `is_creator_core` is the gate: true rows get scanned via Alchemy
-- getAssetTransfers; false rows are remembered so we don't re-probe.

CREATE TABLE IF NOT EXISTS manifold_contracts (
  artist            TEXT NOT NULL,
  contract          TEXT NOT NULL,
  is_creator_core   BOOLEAN NOT NULL,
  is_erc721         BOOLEAN NOT NULL DEFAULT FALSE,
  is_erc1155        BOOLEAN NOT NULL DEFAULT FALSE,
  collection_name   TEXT,
  classified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artist, contract)
);

CREATE INDEX IF NOT EXISTS manifold_contracts_artist_idx
  ON manifold_contracts (artist);
