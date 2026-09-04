-- Canonical ownership read model for tokens PND already indexes.
--
-- `token_ownership` is current ERC-721 state. `token_balances_1155` is the
-- holder ledger ERC-1155 requires. Both carry their evidence watermark so a
-- profile can say exactly how current and complete its result is without a
-- request-time chain read.
--
-- `token_owners` remains available during the migration. Bidirectional
-- triggers keep legacy writers/readers compatible while worker tasks move to
-- the richer model. The canonical table's (block, log_index) ordering fixes
-- same-block transfers, which `token_owners.transferred_at_block` alone could
-- not order.

CREATE TABLE IF NOT EXISTS token_ownership (
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  owner            TEXT NOT NULL,
  source           TEXT NOT NULL,
  last_block       BIGINT NOT NULL,
  log_index        BIGINT NOT NULL,
  tx_hash          TEXT,
  block_time       BIGINT,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized        BOOLEAN NOT NULL DEFAULT FALSE,
  coverage_status  TEXT NOT NULL,
  PRIMARY KEY (contract, token_id),
  CONSTRAINT token_ownership_coverage_status_check
    CHECK (coverage_status IN ('complete', 'partial', 'snapshot', 'stale'))
);

-- Keyset order for collector pages. Contract/token_id make equal-position
-- rows deterministic without changing the required owner/block/log prefix.
CREATE INDEX IF NOT EXISTS token_ownership_collector_idx
  ON token_ownership
    (owner, last_block DESC, log_index DESC, contract, token_id)
  WHERE owner <> '0x0000000000000000000000000000000000000000';

CREATE INDEX IF NOT EXISTS token_ownership_freshness_idx
  ON token_ownership (source, last_block DESC, log_index DESC);

-- Preserve the old table while giving legacy consumers same-block ordering.
ALTER TABLE token_owners
  ADD COLUMN IF NOT EXISTS transferred_at_log_index BIGINT NOT NULL DEFAULT -1;

CREATE INDEX IF NOT EXISTS token_owners_collector_keyset_idx
  ON token_owners
    (owner, transferred_at_block DESC, transferred_at_log_index DESC, contract, token_id)
  WHERE owner <> '0x0000000000000000000000000000000000000000';

-- Seed the canonical model from existing snapshots. A later event-derived row
-- replaces this only when it has newer (block, log_index) evidence.
INSERT INTO token_ownership (
  contract,
  token_id,
  owner,
  source,
  last_block,
  log_index,
  tx_hash,
  block_time,
  observed_at,
  finalized,
  coverage_status
)
SELECT
  lower(contract),
  token_id,
  lower(owner),
  'legacy-token-owners',
  transferred_at_block,
  transferred_at_log_index,
  tx_hash,
  NULLIF(transferred_at_time, 0),
  CASE
    WHEN transferred_at_time > 0 THEN to_timestamp(transferred_at_time)
    ELSE NOW()
  END,
  FALSE,
  'snapshot'
FROM token_owners
ON CONFLICT (contract, token_id) DO NOTHING;

-- Existing worker paths can continue writing token_owners while the scanner
-- migration lands. They become explicitly-labelled snapshots in the canonical
-- table; event-derived writers use token_ownership directly.
CREATE OR REPLACE FUNCTION mirror_token_owners_to_canonical()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  INSERT INTO token_ownership (
    contract,
    token_id,
    owner,
    source,
    last_block,
    log_index,
    tx_hash,
    block_time,
    observed_at,
    finalized,
    coverage_status
  ) VALUES (
    lower(NEW.contract),
    NEW.token_id,
    lower(NEW.owner),
    'legacy-token-owners',
    NEW.transferred_at_block,
    NEW.transferred_at_log_index,
    NEW.tx_hash,
    NULLIF(NEW.transferred_at_time, 0),
    CASE
      WHEN NEW.transferred_at_time > 0 THEN to_timestamp(NEW.transferred_at_time)
      ELSE NOW()
    END,
    FALSE,
    'snapshot'
  )
  ON CONFLICT (contract, token_id) DO UPDATE SET
    owner = EXCLUDED.owner,
    source = EXCLUDED.source,
    last_block = EXCLUDED.last_block,
    log_index = EXCLUDED.log_index,
    tx_hash = EXCLUDED.tx_hash,
    block_time = EXCLUDED.block_time,
    observed_at = EXCLUDED.observed_at,
    finalized = EXCLUDED.finalized,
    coverage_status = EXCLUDED.coverage_status
  WHERE (token_ownership.last_block, token_ownership.log_index)
        <= (EXCLUDED.last_block, EXCLUDED.log_index);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS token_owners_to_canonical ON token_owners;
CREATE TRIGGER token_owners_to_canonical
AFTER INSERT OR UPDATE OF
  owner,
  transferred_at_block,
  transferred_at_log_index,
  transferred_at_time,
  tx_hash
ON token_owners
FOR EACH ROW
EXECUTE FUNCTION mirror_token_owners_to_canonical();

-- Canonical writes keep old token detail and platform queries working. The
-- tuple guard prevents an older observation from replacing a same-block later
-- transfer.
CREATE OR REPLACE FUNCTION mirror_canonical_to_token_owners()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  INSERT INTO token_owners (
    contract,
    token_id,
    owner,
    transferred_at_block,
    transferred_at_log_index,
    transferred_at_time,
    tx_hash
  ) VALUES (
    lower(NEW.contract),
    NEW.token_id,
    lower(NEW.owner),
    NEW.last_block,
    NEW.log_index,
    COALESCE(NEW.block_time, 0),
    NEW.tx_hash
  )
  ON CONFLICT (contract, token_id) DO UPDATE SET
    owner = EXCLUDED.owner,
    transferred_at_block = EXCLUDED.transferred_at_block,
    transferred_at_log_index = EXCLUDED.transferred_at_log_index,
    transferred_at_time = EXCLUDED.transferred_at_time,
    tx_hash = EXCLUDED.tx_hash
  WHERE (token_owners.transferred_at_block, token_owners.transferred_at_log_index)
        <= (EXCLUDED.transferred_at_block, EXCLUDED.transferred_at_log_index);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canonical_to_token_owners ON token_ownership;
CREATE TRIGGER canonical_to_token_owners
AFTER INSERT OR UPDATE OF
  owner,
  last_block,
  log_index,
  tx_hash,
  block_time
ON token_ownership
FOR EACH ROW
EXECUTE FUNCTION mirror_canonical_to_token_owners();

-- Event ledger makes ERC-1155 replay idempotent. TransferBatch is expanded to
-- one row per token id, so token_id belongs in the primary key.
CREATE TABLE IF NOT EXISTS token_1155_balance_events (
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  from_addr        TEXT NOT NULL,
  to_addr          TEXT NOT NULL,
  amount           NUMERIC(78, 0) NOT NULL,
  block_number     BIGINT NOT NULL,
  log_index        BIGINT NOT NULL,
  tx_hash          TEXT NOT NULL,
  source           TEXT NOT NULL,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized        BOOLEAN NOT NULL DEFAULT FALSE,
  coverage_status  TEXT NOT NULL,
  PRIMARY KEY (contract, tx_hash, log_index, token_id),
  CONSTRAINT token_1155_balance_events_amount_check CHECK (amount >= 0),
  CONSTRAINT token_1155_balance_events_coverage_status_check
    CHECK (coverage_status IN ('complete', 'partial', 'snapshot', 'stale'))
);

CREATE INDEX IF NOT EXISTS token_1155_balance_events_token_idx
  ON token_1155_balance_events
    (contract, token_id, block_number DESC, log_index DESC);

CREATE TABLE IF NOT EXISTS token_balances_1155 (
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  holder           TEXT NOT NULL,
  balance          NUMERIC(78, 0) NOT NULL,
  source           TEXT NOT NULL,
  last_block       BIGINT NOT NULL,
  log_index        BIGINT NOT NULL,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized        BOOLEAN NOT NULL DEFAULT FALSE,
  coverage_status  TEXT NOT NULL,
  PRIMARY KEY (contract, token_id, holder),
  CONSTRAINT token_balances_1155_balance_check CHECK (balance > 0),
  CONSTRAINT token_balances_1155_coverage_status_check
    CHECK (coverage_status IN ('complete', 'partial', 'snapshot', 'stale'))
);

CREATE INDEX IF NOT EXISTS token_balances_1155_collector_idx
  ON token_balances_1155
    (holder, last_block DESC, log_index DESC, contract, token_id)
  WHERE balance > 0;

CREATE INDEX IF NOT EXISTS token_balances_1155_token_idx
  ON token_balances_1155 (contract, token_id, holder);

CREATE OR REPLACE VIEW token_1155_holder_counts AS
SELECT contract, token_id, COUNT(*)::BIGINT AS holder_count
FROM token_balances_1155
WHERE balance > 0
GROUP BY contract, token_id;

-- One normalized SELECT surface for collector queries. This deliberately
-- excludes the zero address and preserves coverage/finality instead of making
-- a wallet profile look exhaustive when a source is partial.
CREATE OR REPLACE VIEW token_holdings_current AS
SELECT
  contract,
  token_id,
  'erc721'::TEXT AS token_standard,
  owner AS holder,
  1::NUMERIC(78, 0) AS balance,
  source,
  last_block,
  log_index,
  observed_at,
  finalized,
  coverage_status
FROM token_ownership
WHERE owner <> '0x0000000000000000000000000000000000000000'

UNION ALL

SELECT
  contract,
  token_id,
  'erc1155'::TEXT AS token_standard,
  holder,
  balance,
  source,
  last_block,
  log_index,
  observed_at,
  finalized,
  coverage_status
FROM token_balances_1155
WHERE balance > 0;
