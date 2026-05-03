-- Sampled log of RPC calls so we can see which pages drive the most
-- /api/rpc traffic and which server endpoints fan out the most upstream
-- Alchemy calls.
--
-- Read paths (in apps/web/src/lib/rpc-log.ts):
--   * /api/rpc proxy logs one row per request, with `referer` set to
--     the pathname of the calling page.
--   * Server-side fanouts (alchemy.ts enhanced API + the viem client
--     wrappers in alchemy-rpc.ts) log one row per upstream call, with
--     `route` set to the API handler that initiated the work.
--
-- Sampling: rpc-log.ts samples at RPC_LOG_SAMPLE (default 0.1). Aggregate
-- queries should multiply counts by 1/sample to estimate true volume.
--
-- Retention: rows older than ~14 days are pruned by the cron entry in
-- /api/cron. Indexes target the three primary query shapes: top
-- referrers, top server routes, noisiest IPs.

CREATE TABLE IF NOT EXISTS rpc_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT NOT NULL,        -- 'proxy' | 'server'
  route       TEXT,                 -- API route path for server-side fanouts
  method      TEXT NOT NULL,        -- JSON-RPC method, or 'alchemy_*' for enhanced API
  referer     TEXT,                 -- pathname only (no host/query) for /api/rpc calls
  ip_hash     TEXT,                 -- truncated SHA-256(ip + RPC_LOG_SALT)
  duration_ms INTEGER,
  status      INTEGER,
  upstream    TEXT,                 -- host of the upstream RPC that served the call
  ok          BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS rpc_events_ts_idx ON rpc_events (ts DESC);
CREATE INDEX IF NOT EXISTS rpc_events_route_ts_idx ON rpc_events (route, ts DESC);
CREATE INDEX IF NOT EXISTS rpc_events_referer_ts_idx ON rpc_events (referer, ts DESC);
CREATE INDEX IF NOT EXISTS rpc_events_ip_hash_ts_idx ON rpc_events (ip_hash, ts DESC);
