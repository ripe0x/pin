-- Sampled RPC call log written by apps/web/src/lib/rpc-log.ts.
-- Created by migration 014 on the pre-rebuild database and never recreated
-- on maglev, so every sampled insert failed with "relation does not exist".
-- ponytail: no retention; rows are sampled (5-10%) and tiny. Add a prune
-- task if the table passes a few hundred MB.
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
