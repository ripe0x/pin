-- Indexes for scan-token-transfers' block-time drain, which runs every
-- 5 minutes (audit M8, #295).
--
-- backfillBlockTimes() asks for
--   SELECT DISTINCT block_number FROM token_transfers
--   WHERE block_time = 0 ORDER BY block_number LIMIT 100
-- and then, per block, updates
--   token_transfers WHERE block_number = $1 AND block_time = 0
--   token_owners    WHERE transferred_at_block = $1 AND transferred_at_time = 0
-- None of those predicates had an index, so each tick sequentially
-- scanned token_transfers once and token_owners up to 100 times, even
-- after the drain had finished. Partial indexes over just the zero-time
-- rows are tiny once drained and turn every one of those into an index
-- lookup.
--
-- The other hot worker lookups (artist_tokens / token_owners by
-- (contract, token_id), worker_cursors by (task, scope)) are PK lookups
-- once the worker stops wrapping the already-lowercase contract column
-- in lower(); no index is needed for them.
--
-- Plain CREATE INDEX (db/migrate.mjs runs each file in a transaction, so
-- CONCURRENTLY isn't available): it blocks writes to the two tables, not
-- reads, for the duration of the build.

CREATE INDEX IF NOT EXISTS token_transfers_zero_time_idx
  ON token_transfers (block_number)
  WHERE block_time = 0;

CREATE INDEX IF NOT EXISTS token_owners_zero_time_idx
  ON token_owners (transferred_at_block)
  WHERE transferred_at_time = 0;
