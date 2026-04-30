-- Per-contract classification cache. Used by collector adapters that
-- need to filter Alchemy `getNFTsForOwner` results to only the contracts
-- that match a platform's interface (e.g., Manifold creator cores via
-- `supportsInterface(0x28f10a21)`).
--
-- Without this cache, every collector view would re-issue
-- `supportsInterface` calls for every contract the wallet owns tokens
-- on. With it, classification is one supportsInterface call per
-- contract, ever.
--
-- `kind` is platform-defined: "manifold-cc-v1" today; future platforms
-- will add their own values. Multiple kinds CAN apply to one contract
-- (e.g., if SuperRare tokens implement multiple interfaces); the
-- caller's read should filter by kind.

CREATE TABLE IF NOT EXISTS lazy_contract_classification (
  contract         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  is_match         BOOLEAN NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, kind)
);
CREATE INDEX IF NOT EXISTS lazy_contract_classification_kind_match_idx
  ON lazy_contract_classification (kind, is_match);
