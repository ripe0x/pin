-- Transient Labs artist-tokens move into Ponder. After this:
--   - TL artist-token discovery reads from `ponder_v*.tl_artist_tokens`
--     (populated by the new TLCollection handlers).
--   - The web app's `lazy_tl_artist_tokens` + `lazy_tl_artist_status`
--     tables are unreferenced and get dropped here.
--
-- known_artists view: TL did not feed it (TL deployers weren't auto-
-- promoted the way Mint creators were). No view recreation needed.
-- Idempotent: DROP TABLE IF EXISTS.

DROP TABLE IF EXISTS lazy_tl_artist_tokens CASCADE;
DROP TABLE IF EXISTS lazy_tl_artist_status CASCADE;
