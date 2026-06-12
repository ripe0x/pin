-- token_metadata.burned: a definitive "this token no longer exists on-chain"
-- flag (burned, or never minted). Set when a `tokenURI` read reverts with a
-- recognized nonexistent-token error (OZ v5 `ERC721NonexistentToken`,
-- ERC721A `URIQueryForNonexistentToken` / `OwnerQueryForNonexistentToken`,
-- or the legacy OZ string reverts). The signal falls out of the metadata
-- read we already make — no extra `ownerOf` call — so burned works can be
-- filtered out of artist grids and 404'd on the token page without spending
-- a per-tile RPC.
--
-- Default false (existing rows are assumed live until a read proves
-- otherwise). NOT a re-resolve target: once burned, never re-fetched —
-- nonexistence is permanent for a given (contract, token_id).
--
-- For ADMITTED artists the equivalent signal already exists as
-- `token_owners.owner = 0x0` (the worker's transfer scanner records the
-- burn Transfer's zero `to`); this column adds the SAME coverage for the
-- unclaimed/seed path, where no per-contract transfer scan runs.

ALTER TABLE token_metadata
  ADD COLUMN IF NOT EXISTS burned BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index for the rare "enumerate burned tokens" maintenance query.
-- The hot read path (grid filter) probes by the (contract, token_id) PK, so
-- it doesn't need this — kept small via the WHERE clause.
CREATE INDEX IF NOT EXISTS token_metadata_burned_idx
  ON token_metadata (contract, token_id)
  WHERE burned;
