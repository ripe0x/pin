-- SuperRare V2 artist-tokens move into Ponder. After this:
--   - SR V2 artist-token discovery reads from
--     `ponder_v*.srv2_artist_tokens` (populated by the
--     SuperRareNFT:Transfer handler).
--   - The web app's `lazy_srv2_artist_tokens` + `lazy_srv2_artist_status`
--     tables are unreferenced and get dropped here.
--
-- known_artists view: SR V2 didn't feed it (SR creators weren't auto-
-- promoted the way Mint creators were). No view recreation needed.
-- Idempotent: DROP TABLE IF EXISTS.

DROP TABLE IF EXISTS lazy_srv2_artist_tokens CASCADE;
DROP TABLE IF EXISTS lazy_srv2_artist_status CASCADE;
