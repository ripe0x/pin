-- contract_identity: immutable contract facts. Worker-owned (writer:
-- warm-contract-identity).
--
-- The dependency-check + catalog flows JOIN against this table to
-- decorate per-contract rows with name/symbol/standard flags. Without
-- this cache they'd issue a multicall per page render; with it they're
-- pure SELECTs.
--
-- A row exists iff we've ever probed this address. has_bytecode=false +
-- NULL name/symbol means "no contract at that address" — store it
-- anyway so we never re-probe.

CREATE TABLE IF NOT EXISTS contract_identity (
  address       TEXT PRIMARY KEY,
  name          TEXT,
  symbol        TEXT,
  has_bytecode  BOOLEAN NOT NULL,
  is_erc721     BOOLEAN NOT NULL,
  is_erc1155    BOOLEAN NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contract_identity_fetched_at_idx
  ON contract_identity (fetched_at);
