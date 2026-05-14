-- Persistent contract identity. Same precedent as `token_metadata`
-- (migration 015): demote the 1h pgCache layer and store the columns
-- that don't change over a contract's lifetime in a permanent index.
-- Reduces the /api/contract-info route from "one eth_call multicall per
-- address per hour" to "one eth_call multicall per address ever."
--
-- Identity is the slice we keep here: name, symbol, has_bytecode, and
-- the ERC-{721,1155} standard flags. These derive from immutable
-- contract state (function returns, supportsInterface flags). A
-- contract's name/symbol can technically change if it implements
-- mutator functions, but in practice for the NFT contracts artists
-- declare in their record, it doesn't.
--
-- Deliberately excluded: totalSupply. Supply is the one mutable field
-- on the original response; the API route reads it through its own
-- short-TTL pgCache so refreshes happen there. The record list pages
-- don't read supply at all, so most reads stay pure DB.
--
-- Row contract: a row exists iff we've ever probed this address. All
-- text columns are nullable; an address with no bytecode stores
-- has_bytecode=false and NULL name/symbol — store it anyway so we
-- never re-probe a known-empty address.
--
-- Re-fetch policy: by default, never. If a contract's name ever
-- legitimately changes and matters, a periodic sweep over rows older
-- than N days can re-resolve; fetched_at supports that without a
-- schema change.

CREATE TABLE IF NOT EXISTS contract_identity (
  address       TEXT PRIMARY KEY,
  name          TEXT,
  symbol        TEXT,
  has_bytecode  BOOLEAN NOT NULL,
  is_erc721     BOOLEAN NOT NULL,
  is_erc1155    BOOLEAN NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports an optional "re-resolve entries older than N days" sweep
-- without a full table scan.
CREATE INDEX IF NOT EXISTS contract_identity_fetched_at_idx
  ON contract_identity (fetched_at);
