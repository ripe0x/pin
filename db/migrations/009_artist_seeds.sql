-- artist_seeds: manual additions to the known_artists set. Use cases:
--   - Artists who pre-date the indexed window (Foundation startBlock
--     for FND alumni; SR V2 deploy block for SR alumni).
--   - Artists who haven't yet deployed a Sovereign house, FND
--     collection, or Mint/TL clone, but who you want indexed.
--   - Internal testing artists.
--
-- Operator-managed via SQL or a future admin UI. The known_artists
-- view UNIONs this in alongside the Ponder-derived sources.

CREATE TABLE IF NOT EXISTS artist_seeds (
  address    TEXT PRIMARY KEY,
  source     TEXT,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes      TEXT
);
