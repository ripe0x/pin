-- On-demand thumbnail queue. The web app inserts a row the first time it
-- renders a token that has no token_media_delivery row; the
-- derive-token-media worker task only derives tokens listed here. Tokens
-- nobody views are never fetched, resized or stored.

CREATE TABLE IF NOT EXISTS token_media_requests (
  contract     TEXT NOT NULL,
  token_id     TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract, token_id)
);
