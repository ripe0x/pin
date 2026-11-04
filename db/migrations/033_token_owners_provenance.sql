-- token_owners provenance: same-block ordering and the writer's source
-- (#296, ownership C2 worker side).
--
-- token_owners was "resolve once at mint" for the Foundation shared and
-- SuperRare V2 1/1 contracts: scan-token-transfers skips both (they are
-- the unbounded shared contracts v2 refuses to scan), so the only row a
-- shared token ever got was the ownerOf answer read right after the mint
-- scanner found it, stale after the first sale. Ponder now keeps the
-- current owner of every Transfer on both contracts
-- (`<INDEXER_SCHEMA>.token_ownership`, ponder_v5+), and the worker's
-- mirror-shared-owners task copies it here. Two columns let that mirror
-- (and anything after it) order observations correctly:
--
--   transferred_at_log_index  Log index of the Transfer that set the row,
--                             so two transfers of one token in the same
--                             block order by (block, log index), not by
--                             whichever write landed last. -1 = unknown
--                             (every row written before this migration,
--                             and the legacy writers that don't set it).
--   source                    Who wrote the row. NULL = the legacy worker
--                             writers (scan-token-transfers, the Manifold
--                             fast path, resolve-owner's ownerOf at mint).
--                             'ponder:superrare-v2' / 'ponder:foundation-
--                             shared' = mirrored from Ponder's Transfer
--                             stream (finalized blocks only). 'ownerof' =
--                             mirror-shared-owners' one-time ownerOf for a
--                             pre-FND_START_BLOCK Foundation token Ponder
--                             has no Transfer for.
--
-- Both are additive with constant defaults, so this is a metadata-only
-- change on Postgres 11+ (no table rewrite) and every existing writer and
-- reader keeps working unchanged.

ALTER TABLE token_owners
  ADD COLUMN IF NOT EXISTS transferred_at_log_index BIGINT NOT NULL DEFAULT -1;

ALTER TABLE token_owners
  ADD COLUMN IF NOT EXISTS source TEXT;
