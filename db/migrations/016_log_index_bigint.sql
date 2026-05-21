-- Widen log_index columns from INTEGER to BIGINT.
--
-- Some chain events emit logIndex values up to uint32 max (4,294,967,295)
-- which exceeds Postgres INTEGER's signed 32-bit max (2,147,483,647).
-- This was crashing scan-mint-clones with:
--   value "4294967295" is out of range for type integer
--
-- Postgres handles ALTER TYPE INTEGER -> BIGINT without a table rewrite
-- in modern versions; the operation is essentially metadata-only.

ALTER TABLE artist_tokens     ALTER COLUMN mint_log_index TYPE BIGINT;
ALTER TABLE token_transfers   ALTER COLUMN log_index      TYPE BIGINT;
