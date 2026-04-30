-- Tier 3 lazy indexer tables. Same pattern as 002: web app's RPC fallback
-- paths UPSERT here on first miss; subsequent reads collapse to a point
-- query.

-- ─── ERC-1155 transfer stream per contract ────────────────────────────────
-- Backs `getErc1155TokenStats`. The current `getErc1155TransferStream`
-- pgCache layer is 10 min TTL — every active ERC-1155 contract pays for
-- a full `alchemy_getAssetTransfers` (paginated, 150 CU per page) on
-- every cache miss. Lazy with longer TTL collapses repeat misses.
--
-- Stored as a JSON blob per contract because Alchemy's
-- `alchemy_getAssetTransfers` doesn't surface `logIndex` per transfer,
-- so a structured per-transfer primary key isn't reliable. The JSON
-- shape matches what `getErc1155TokenStatsUncached` filters in-memory.
CREATE TABLE IF NOT EXISTS lazy_erc1155_streams (
  contract         TEXT PRIMARY KEY,
  is_erc1155       BOOLEAN NOT NULL,
  transfers_json   JSONB NOT NULL,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Manifold per-artist token enumeration ────────────────────────────────
-- Backs `discoverManifoldTokenRefs`. Today it calls Etherscan to find an
-- artist's deployed Manifold creator cores, then paginates Alchemy's NFT
-- API per contract (150 CU per page, capped at 20 pages by the Phase 1
-- bound). Lazy collapses both halves: store the resolved (creator,
-- contract, tokenId) tuples once per artist.
CREATE TABLE IF NOT EXISTS lazy_manifold_artist_tokens (
  creator          TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  collection_name  TEXT,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (creator, contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_manifold_artist_tokens_creator_idx
  ON lazy_manifold_artist_tokens (creator);

CREATE TABLE IF NOT EXISTS lazy_manifold_artist_status (
  creator          TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
