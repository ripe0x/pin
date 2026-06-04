-- cid_availability: cache of "is this CID retrievable from a public
-- IPFS gateway?" Populated by the worker task
-- `apps/worker/src/tasks/probe-cid-availability.ts` and read by the
-- web app's dependency-report Preservation summary
-- (`apps/web/src/lib/dependency-check.ts:getPreservationSummary`).
--
-- Critical amortization: CIDs are content-addressed. The same `Qm...`
-- (or `bafy...`) referenced by N artists is one row, populated once.
-- That changes the cost profile completely from per-token RPC and is
-- the reason this can ship as a single global cache rather than a
-- per-artist scan.
--
-- Probe budget — see `probe-cid-availability.ts` for the runtime
-- constants:
--   * gateways: ipfs.io, dweb.link, w3s.link (free, public; no key)
--   * per CID: race 3 gateways with a 3s HEAD timeout. First success
--     wins → `retrievable = true`, `gateways_ok` includes that host.
--     All fail → `retrievable = false`, `gateways_failed` includes
--     each host tried.
--   * refresh cadence: every 7 days. Pin churn is slow.
--
-- Note on `http_status`: when a request actually got an HTTP response
-- this is populated (200, 404, 429, etc.); for race-winners we record
-- the success status; for all-fail rows we record the *last* observed
-- status (or NULL if the failure was a transport-level timeout, not
-- an HTTP response).

CREATE TABLE IF NOT EXISTS cid_availability (
  cid               TEXT PRIMARY KEY,
  last_probed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retrievable       BOOLEAN NOT NULL,
  gateways_ok       TEXT[] NOT NULL DEFAULT '{}',
  gateways_failed   TEXT[] NOT NULL DEFAULT '{}',
  http_status       INTEGER
);

-- Index for `find candidates whose last probe is older than N days`.
CREATE INDEX IF NOT EXISTS cid_availability_stale_idx
  ON cid_availability (last_probed_at);
