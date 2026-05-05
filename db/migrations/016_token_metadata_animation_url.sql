-- Surface ERC-721/1155 `animation_url` on the token page. The original
-- `token_metadata` schema only kept `image`, so dynamic media (mp4/webm
-- audio-visual works, on-chain HTML art) rendered as the static poster
-- image. Adding the column lets `resolveTokenMetadataDirect` cache it
-- alongside the rest of the metadata so we don't have to re-fetch the
-- JSON on every page render.
--
-- Backfill: existing rows keep `animation_url = NULL`. There's no way
-- to distinguish "we resolved this token before the column existed and
-- it has an animation" from "the token genuinely has no animation"
-- without re-fetching, and lazy re-fetch defeats the cache. Operators
-- who want the field populated for a specific token can clear the row
-- (DELETE FROM token_metadata WHERE …) and the next read will resolve
-- fresh.

ALTER TABLE token_metadata
  ADD COLUMN IF NOT EXISTS animation_url TEXT;
