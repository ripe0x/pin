-- Consecutive empty fetches by the worker's warm-metadata task. Drives its
-- exponential retry backoff so tokens that never resolve (no contract code,
-- tokenURI reverts) stop being re-fetched every few minutes forever.
-- Reset to 0 when a fetch returns content.
ALTER TABLE token_metadata
  ADD COLUMN IF NOT EXISTS fetch_attempts INTEGER NOT NULL DEFAULT 0;
