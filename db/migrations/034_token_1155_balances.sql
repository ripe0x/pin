-- ERC-1155 holder balances (#296, ownership C2 worker side).
--
-- token_owners is one row per token, which can't describe an edition held
-- by many wallets, so ERC-1155 had no holder model at all: no collector
-- inverse query, and token_1155_stats.owner_count stuck at 0 ("—").
--
-- Writer: the worker's scan-1155-balances task, over the ERC-1155
-- contracts known artists DEPLOYED (Mint protocol clones from
-- mint_creators, Manifold Creator Cores classified is_erc1155). Every
-- TransferSingle / TransferBatch on those contracts, mints and burns
-- included, from the contract's first block. Nothing outside the
-- known_artists spend ceiling is scanned; contracts an artist merely
-- minted on (shared storefronts) are out of scope on purpose.
--
-- Two tables, and why balances are RECOMPUTED rather than incremented:
--
--   token_1155_transfers  Raw log ledger, one row per (tx_hash, log_index,
--                         batch_index): a TransferSingle is batch_index 0,
--                         a TransferBatch is expanded to one row per array
--                         position (a batch may repeat an id, so the id
--                         can't be the key). Inserts are ON CONFLICT DO
--                         NOTHING, so the scanner's replay overlap and
--                         re-scans of a range are no-ops.
--   token_1155_balances   Current balance per (contract, token_id, holder),
--                         > 0 only (a holder that reaches 0 has no row).
--                         A pure function of the ledger:
--                           Σ amount received − Σ amount sent
--                         with the zero address excluded on both sides
--                         (mint credits only `to`, burn debits only
--                         `from`; a self-transfer nets to zero).
--
-- The scanner inserts a range's logs and, in the same transaction, calls
-- pnd_recompute_token_1155_balances() for exactly the tokens whose ledger
-- gained a row. Recomputing from the ledger (instead of applying deltas
-- per new log) means:
--   - replay can't double-count: a re-read log inserts nothing and
--     triggers no recompute;
--   - order doesn't matter: a range scanned late (a group member that
--     started below the group, a backfill) can't drive an intermediate
--     balance negative or trip a CHECK;
--   - a bug or a manual ledger repair is fixed by re-running the function,
--     no rescan: SELECT pnd_recompute_token_1155_balances(
--       ARRAY(SELECT contract FROM ...), ARRAY(SELECT token_id FROM ...));
-- The scanner only reads finalized blocks (finality.ts), so the ledger
-- never holds an orphaned log that would need to be removed.
--
-- updated_block is the last ledger block that touched that holder's
-- balance for the token: the "acquired / last changed" position used to
-- order collector pages. Coverage of a contract is its scan cursor
-- (worker_cursors task 'scan-1155-balances', scope = contract): balances
-- are complete through that block once the first backfill has caught up.

CREATE TABLE IF NOT EXISTS token_1155_transfers (
  contract      TEXT            NOT NULL,
  token_id      TEXT            NOT NULL,
  operator      TEXT            NOT NULL,
  from_addr     TEXT            NOT NULL,
  to_addr       TEXT            NOT NULL,
  amount        NUMERIC(78, 0)  NOT NULL CHECK (amount >= 0),
  block_number  BIGINT          NOT NULL,
  log_index     BIGINT          NOT NULL,
  batch_index   INTEGER         NOT NULL DEFAULT 0,
  tx_hash       TEXT            NOT NULL,
  PRIMARY KEY (tx_hash, log_index, batch_index)
);

-- Per-token recompute and the collector read's "is this contract 1155"
-- probe (prefix: contract).
CREATE INDEX IF NOT EXISTS token_1155_transfers_token_idx
  ON token_1155_transfers (contract, token_id);

CREATE TABLE IF NOT EXISTS token_1155_balances (
  contract       TEXT            NOT NULL,
  token_id       TEXT            NOT NULL,
  holder         TEXT            NOT NULL,
  balance        NUMERIC(78, 0)  NOT NULL CHECK (balance > 0),
  updated_block  BIGINT          NOT NULL,
  PRIMARY KEY (contract, token_id, holder)
);

-- Collector inverse query: "what does this wallet hold", newest first.
CREATE INDEX IF NOT EXISTS token_1155_balances_holder_idx
  ON token_1155_balances (holder, updated_block DESC, contract, token_id);

-- Replace the balances of the given tokens with the ledger's answer.
-- p_contracts[i] / p_token_ids[i] name one token; duplicates are fine.
-- Returns the number of balance rows written or removed.
CREATE OR REPLACE FUNCTION public.pnd_recompute_token_1155_balances(
  p_contracts text[],
  p_token_ids text[]
)
RETURNS integer
LANGUAGE sql
AS $fn$
  WITH affected AS (
    SELECT DISTINCT a.contract, a.token_id
    FROM unnest(p_contracts, p_token_ids) AS a(contract, token_id)
  ),
  computed AS (
    SELECT d.contract, d.token_id, d.holder,
           SUM(d.delta) AS balance, MAX(d.block_number) AS updated_block
    FROM (
      SELECT t.contract, t.token_id, t.to_addr AS holder, t.amount AS delta, t.block_number
      FROM public.token_1155_transfers t
      JOIN affected a ON a.contract = t.contract AND a.token_id = t.token_id
      WHERE t.to_addr <> '0x0000000000000000000000000000000000000000'
      UNION ALL
      SELECT t.contract, t.token_id, t.from_addr, -t.amount, t.block_number
      FROM public.token_1155_transfers t
      JOIN affected a ON a.contract = t.contract AND a.token_id = t.token_id
      WHERE t.from_addr <> '0x0000000000000000000000000000000000000000'
    ) d
    GROUP BY d.contract, d.token_id, d.holder
    -- A negative sum means the ledger is missing the holder's earlier
    -- receipt (history before the scan start); never store it.
    HAVING SUM(d.delta) > 0
  ),
  -- Holders of an affected token that no longer hold it (balance reached
  -- 0, or a ledger repair removed it). One statement, so the delete and
  -- the upsert below see the same snapshot and never collide.
  removed AS (
    DELETE FROM public.token_1155_balances b
    USING affected a
    WHERE b.contract = a.contract AND b.token_id = a.token_id
      AND NOT EXISTS (
        SELECT 1 FROM computed c
        WHERE c.contract = b.contract AND c.token_id = b.token_id AND c.holder = b.holder
      )
    RETURNING 1
  ),
  written AS (
    INSERT INTO public.token_1155_balances (contract, token_id, holder, balance, updated_block)
    SELECT contract, token_id, holder, balance, updated_block FROM computed
    ON CONFLICT (contract, token_id, holder) DO UPDATE SET
      balance = EXCLUDED.balance,
      updated_block = EXCLUDED.updated_block
    WHERE (token_1155_balances.balance, token_1155_balances.updated_block)
          IS DISTINCT FROM (EXCLUDED.balance, EXCLUDED.updated_block)
    RETURNING 1
  )
  SELECT ((SELECT count(*) FROM written) + (SELECT count(*) FROM removed))::integer
$fn$;
