-- Widen token_1155_mints.log_index INTEGER -> BIGINT.
--
-- Same class of fix as 016 (which widened artist_tokens.mint_log_index and
-- token_transfers.log_index), but 017 created token_1155_mints with log_index
-- as INTEGER. Some mint logs report a logIndex above INT4_MAX (2,147,483,647) —
-- e.g. Visualize Value's "Tradeoffs" clone has TransferSingle logs at logIndex
-- 4,294,967,294/295 (~2^32). The INTEGER insert overflowed and the row was
-- dropped (the scanner's per-clone catch swallowed the error), silently
-- under-indexing high-volume editions. BIGINT holds the full uint range.
--
-- log_index is part of the primary key (tx_hash, log_index, token_id); widening
-- the type is safe and preserves existing rows.

ALTER TABLE token_1155_mints
  ALTER COLUMN log_index TYPE BIGINT;
