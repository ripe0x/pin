-- Mint protocol (Visualize Value) lazy index. Mirrors the SR V2 / TL
-- schema (006, 007). Two tables: per-token rows + a per-creator status
-- row that carries the incremental scan cursor from the start.
--
-- Scope:
--   - Artist-side mint discovery. The Factory emits
--     `Created(address indexed ownerAddress, address contractAddress)`
--     on every per-artist clone; we enumerate the artist's clones via a
--     topic-filtered scan (cheap — indexed creator), then read
--     TransferSingle/TransferBatch from address(0) on each clone to
--     surface every minted token.
--
-- We do NOT cache the clone-contract list separately (cf. Manifold's
-- `lazy_manifold_contracts`): each scan re-queries the Factory with the
-- artist's address as a topic filter, which returns sparse results in
-- one cheap call. Each clone's tokens live as standalone rows in
-- `lazy_mint_artist_tokens`, the only durable state required.
--
-- ERC-1155 specifics:
--   - Multiple mints can share a tokenId on the same contract (editions),
--     so the unique key is (creator, contract, token_id) with
--     `ON CONFLICT DO UPDATE` on the write path — same pattern Manifold
--     uses.
--   - `block_number` + `log_index` come from the first TransferSingle
--     from `0x0` for that tokenId, used to seed an ordering tie-breaker
--     in the gallery.

CREATE TABLE IF NOT EXISTS lazy_mint_artist_tokens (
  creator          TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  block_number     BIGINT NOT NULL,
  log_index        INTEGER NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (creator, contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_mint_artist_tokens_creator_idx
  ON lazy_mint_artist_tokens (creator, block_number DESC);

CREATE TABLE IF NOT EXISTS lazy_mint_artist_status (
  creator             TEXT PRIMARY KEY,
  last_indexed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scanned_block  BIGINT
);
