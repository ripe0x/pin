-- token_pins: self-declared pin records. When an artist completes
-- the `/preserve` flow, the client signs a message covering the CIDs
-- it just pinned and POSTs to `/api/preserve/writeback`. The endpoint
-- verifies the signature (proves the caller controls `artist`) and
-- upserts here.
--
-- Layered on top of `cid_availability` (worker-probed gateway
-- retrievability — see migration 018). The Preservation summary in
-- the dependency report shows both: "retrievable via gateway" (anyone
-- can verify by visiting a public gateway) and "artist personally
-- pinned at provider X" (the artist's own pin account, attested by
-- their wallet).
--
-- Trust model: self-declaration. The artist signs a message; the
-- endpoint verifies the signature with `verifyMessage` from viem.
-- We do NOT contact the pinning provider — the provider key never
-- leaves the artist's browser (see apps/web/src/lib/pinning/types.ts:6).
-- That means a malicious artist could claim a pin without actually
-- having one; the public-gateway probe (cid_availability) is the
-- corroborating ground truth.

CREATE TABLE IF NOT EXISTS token_pins (
  artist      TEXT NOT NULL,
  cid         TEXT NOT NULL,
  provider    TEXT NOT NULL,           -- 'pinata' | '4everland' | 'web3storage'
  status      TEXT NOT NULL,           -- 'pinned' | 'queued' | 'failed'
  pinned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artist, cid, provider)
);

CREATE INDEX IF NOT EXISTS token_pins_artist_idx ON token_pins (artist);
CREATE INDEX IF NOT EXISTS token_pins_cid_idx    ON token_pins (cid);
