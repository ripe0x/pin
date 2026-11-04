-- transfer_backfill_queue: transfer history owed to tokens that were
-- discovered after scan-token-transfers' cursor had already passed their
-- blocks (audit H2, #295).
--
-- scan-token-transfers drops every Transfer log whose token isn't in
-- artist_tokens yet, and its per-contract cursor runs independently of
-- (and usually ahead of) mint discovery. Without this queue a token
-- discovered later (mint scanner still backfilling, Manifold fast
-- backfill, scan-pnd-auction-tokens, a newly known artist on an already
-- scanned contract) kept a permanent hole in its provenance.
--
-- Producer: the AFTER INSERT trigger below, so every insert path is
-- covered, including the pure-SQL seed copies, with no per-writer code.
-- It fires only for rows actually inserted (an ON CONFLICT DO NOTHING
-- skip doesn't fire it). Shared-contract platforms ('fnd-shared',
-- 'srv2-shared') and ERC-1155 Mint clones ('mint') are skipped: the
-- forward scan never reads those contracts, so there's nothing to fill.
--
-- Consumer: scan-token-transfers (apps/worker/src/transfer-backfill.ts
-- has the planning rules). Rows are grouped per contract and walked
-- from MIN(next_block) to the forward cursor in one bounded scan;
-- next_block is the saved progress; a finished row is deleted. A failing
-- walk backs off with failures / next_attempt_at.

CREATE TABLE IF NOT EXISTS transfer_backfill_queue (
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  -- First block still to scan for this token. Starts at its mint block.
  next_block       BIGINT NOT NULL,
  failures         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error       TEXT,
  enqueued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);

CREATE INDEX IF NOT EXISTS transfer_backfill_queue_due_idx
  ON transfer_backfill_queue (next_attempt_at, contract);

CREATE OR REPLACE FUNCTION public.pnd_enqueue_transfer_backfill()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO public.transfer_backfill_queue (contract, token_id, next_block)
  VALUES (NEW.contract, NEW.token_id, NEW.mint_block)
  ON CONFLICT (contract, token_id) DO UPDATE SET
    next_block = LEAST(public.transfer_backfill_queue.next_block, EXCLUDED.next_block),
    next_attempt_at = NOW(),
    updated_at = NOW();
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS artist_tokens_enqueue_transfer_backfill ON artist_tokens;
CREATE TRIGGER artist_tokens_enqueue_transfer_backfill
  AFTER INSERT ON artist_tokens
  FOR EACH ROW
  WHEN (NEW.platform NOT IN ('fnd-shared', 'srv2-shared', 'mint'))
  EXECUTE FUNCTION public.pnd_enqueue_transfer_backfill();

-- One-time repair of holes that already exist: tokens on a contract the
-- forward scan demonstrably reads (it has recorded at least one transfer
-- there) but with no transfer of their own, not even the mint. Those are
-- exactly the tokens whose logs were dropped as unknown. Contracts that
-- emit no ERC-721 Transfer at all (ERC-1155 Manifold cores) have no
-- token_transfers rows and are not enqueued.
INSERT INTO transfer_backfill_queue (contract, token_id, next_block)
SELECT t.contract, t.token_id, t.mint_block
FROM artist_tokens t
WHERE t.platform NOT IN ('fnd-shared', 'srv2-shared', 'mint')
  AND EXISTS (
    SELECT 1 FROM token_transfers y WHERE y.contract = t.contract
  )
  AND NOT EXISTS (
    SELECT 1 FROM token_transfers x
    WHERE x.contract = t.contract AND x.token_id = t.token_id
  )
ON CONFLICT (contract, token_id) DO NOTHING;
