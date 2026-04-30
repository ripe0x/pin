-- Collector-side lazy index. Each platform owns its own collector token
-- table; the orchestrator (`/collector/[address]/page.tsx`) loops the
-- registry and unions the results. Same TTL/refresh pattern as the
-- artist-side tables.

-- ─── Foundation collector tokens ──────────────────────────────────────────
-- Tokens currently owned by `wallet` across the FoundationNFT shared
-- contract + every per-artist Foundation collection contract we know
-- about. Populated by scanning `Transfer(to=wallet)` on those contracts.
-- Stale rows where `to` no longer matches reality (token was
-- transferred out) are filtered at read time by re-checking ownerOf;
-- as a future optimization we could persist a `transferredOut` flag.
CREATE TABLE IF NOT EXISTS lazy_fnd_collector_tokens (
  wallet           TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  acquired_at_block BIGINT NOT NULL,
  acquired_tx_hash TEXT,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet, contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_fnd_collector_tokens_wallet_idx
  ON lazy_fnd_collector_tokens (wallet, acquired_at_block DESC);

CREATE TABLE IF NOT EXISTS lazy_fnd_collector_status (
  wallet           TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Manifold collector tokens ────────────────────────────────────────────
-- Manifold's discovery uses the Alchemy NFT API's `getNFTsForOwner`
-- which returns current ownership, not transfer history. Stored as a
-- snapshot per wallet; refreshed when stale.
CREATE TABLE IF NOT EXISTS lazy_manifold_collector_tokens (
  wallet           TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  collection_name  TEXT,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet, contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_manifold_collector_tokens_wallet_idx
  ON lazy_manifold_collector_tokens (wallet);

CREATE TABLE IF NOT EXISTS lazy_manifold_collector_status (
  wallet           TEXT PRIMARY KEY,
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Sovereign (PND) collector tokens ─────────────────────────────────────
-- Tokens won by a wallet via a settled Sovereign auction. Read directly
-- from `pnd_auctions WHERE winner = wallet AND status = 'settled'` —
-- no separate lazy table needed because the data lives in Ponder. Adapter
-- query is a JOIN, not an UPSERT.
