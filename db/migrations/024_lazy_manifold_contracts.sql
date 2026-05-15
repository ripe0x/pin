-- Per-artist Manifold contract cache. Solves the "we keep re-running
-- supportsInterface(0x28f10a21) over every contract this artist has
-- ever deployed" cost on each refresh.
--
-- Before: every refresh hit Etherscan `txlist` for the artist + ran a
-- multicall `supportsInterface` against every deployed contract +
-- Alchemy NFT API `getNFTsForContract` for the surviving Manifold
-- cores. The classification multicall is the slow part.
--
-- After: classification result is cached here. On each refresh, we
-- still re-run `txlist` (cheap, one Etherscan call) to pick up any
-- newly-deployed contracts, but only classify the gaps. Already-
-- classified contracts go straight to the token-enumeration path
-- (Alchemy `getAssetTransfers` with fromBlock).
--
-- Stored as one row per (artist, contract); `is_creator_core` lets us
-- remember "this contract was probed and is not Manifold" so we don't
-- waste a multicall on it again. `collection_name` is the `name()`
-- string we resolved during classification, cached so we don't
-- re-fetch it on display.

CREATE TABLE IF NOT EXISTS lazy_manifold_contracts (
  artist            TEXT NOT NULL,
  contract          TEXT NOT NULL,
  is_creator_core   BOOLEAN NOT NULL,
  is_erc721         BOOLEAN NOT NULL DEFAULT FALSE,
  is_erc1155        BOOLEAN NOT NULL DEFAULT FALSE,
  collection_name   TEXT,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artist, contract)
);
CREATE INDEX IF NOT EXISTS lazy_manifold_contracts_artist_idx
  ON lazy_manifold_contracts (artist);
