-- Collection allowlists: the offchain half of a GateHook merkle gate.
--
-- The artist publishes an address list through the studio; the server
-- builds the OZ standard-merkle-tree and stores the list keyed by
-- (collection, root). The eligibility API serves proofs ONLY for the root
-- that is currently active onchain (GateHook.rootOf), so storage is
-- deliberately permissionless: a stored list whose root the collection's
-- owner never sets onchain grants nothing. The chain is the auth.
--
-- One row per published list. Re-publishing the same list is an upsert;
-- a new list for the same collection gets its own row under its new root
-- (history preserved, and proofs for a re-activated old root keep working).

CREATE TABLE IF NOT EXISTS collection_allowlists (
  collection TEXT NOT NULL, -- lowercase 0x collection address
  root TEXT NOT NULL, -- lowercase 0x 32-byte merkle root
  addresses JSONB NOT NULL, -- lowercase address array, deduped, sorted
  address_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, root)
);

CREATE INDEX IF NOT EXISTS collection_allowlists_collection_idx
  ON collection_allowlists (collection);
