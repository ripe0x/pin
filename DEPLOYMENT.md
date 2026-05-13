# Deployment

Notes for self-hosting the full PND stack: Next.js app + shared Postgres
cache + optional Ponder indexer. Each piece can run independently; the
web app degrades gracefully when Postgres or Ponder is unavailable.

For the indexer-specific gotchas (Ponder schema config, RPC
requirements, recovery flows), see [`ponder/README.md`](./ponder/README.md).

## Topology

The production setup runs on three providers:

```txt
Netlify          Next.js app (server functions + edge)
Railway          Postgres + Ponder service (same project, private network)
RPC provider     Alchemy or any JSON-RPC endpoint
```

Other combinations work — Vercel + Neon + Render, or all-local — the
only architectural requirement is "Postgres reachable from the web app
and from Ponder."

## Postgres

### Provisioning

Any Postgres ≥ 13. Tested on Railway's managed Postgres (15 / 18). Neon
and Supabase work — they auto-issue an SSL-required connection string.
For local dev, plain `postgres:15` in Docker is fine.

The schema is small (one cache table, plus the `ponder.*` tables Ponder
creates if you run the indexer). Storage growth is bounded by unique
tokens visited × time-to-TTL — kilobytes today, MB at scale.

### Connection string

`DATABASE_URL` goes in `apps/web/.env.local` for local dev and in the
hosting platform's env for production. Format:

```txt
postgresql://USER:PASS@HOST:PORT/DBNAME
```

If your provider gives you both a private and a public URL (Railway
does), use the **public** one for Netlify functions and the **private**
one for any service that runs on the same network as Postgres (i.e.
Ponder, if it's on the same Railway project).

### Connection pooling for serverless

[`apps/web/src/lib/db.ts`](apps/web/src/lib/db.ts) configures the
postgres.js client with:

```ts
{ max: 5, idle_timeout: 20, connect_timeout: 10, prepare: false }
```

`max: 5` keeps each Function sandbox to a small pool — without this, a
burst of concurrent functions can blow through Postgres's
`max_connections`. `prepare: false` skips prepared-statement allocation
that has no benefit when each sandbox owns its own pool.

If you observe connection-exhaustion errors under real load, switch to
PgBouncer (Railway add-on) or your provider's pooled endpoint and point
`DATABASE_URL` at the pooler.

### Applying migrations

```bash
npm run db:migrate
```

Idempotent. Reads `DATABASE_URL` from `apps/web/.env.local` via Node's
`--env-file` flag. Runs every `.sql` in `db/migrations/` once; tracks
applied filenames in a `_migrations` table. Re-runs are no-ops.

### Verification

After a few page renders, the cache should be populated:

```sql
SELECT key, expires_at - NOW() AS ttl_left
FROM cache_entries
ORDER BY updated_at DESC
LIMIT 10;
```

You should see rows like `ens:0x…`, `token-metadata:0x…:1`,
`auction:0x…:1`, etc., with positive `ttl_left`.

If `jsonb_typeof(value)` returns `'string'` instead of `'object'`, the
write path is double-stringifying — see commit `9f38305` for the
specific bug if it ever resurfaces.

## Ponder

The indexer is opt-in. If `DATABASE_URL` is set on the web app but
Ponder isn't running, the indexer-first wrappers fall through to the
RPC-cached path — site works, just without the point-query speed-up
for `getActiveAuctionCount`.

Setup is in [`ponder/README.md`](./ponder/README.md). The summary:

1. Deploy `ponder/` as a long-running Node service (Railway, Render,
   Fly, your own VM). Don't try to run it in a Function — it's a
   continuously-syncing process.
2. Point its `DATABASE_URL` at the same Postgres the web app uses.
3. Set `DATABASE_SCHEMA=ponder` on the indexer service so its tables
   live in their own namespace.
4. **Don't** set `PONDER_RPC_URL_1` unless you have a specific reason
   to. The indexer ships with a public-RPC fallback chain
   (publicnode → llamarpc → ankr) wired into `ponder.config.ts` and
   doesn't need a paid endpoint. If set, `PONDER_RPC_URL_1` sits at
   the end of the chain as a last-resort safety net only. See
   [`ponder/README.md`](./ponder/README.md#rpc-strategy) for why.
5. Set `INDEXER_SCHEMA=ponder` on the web app so it knows where
   Ponder writes.

Ongoing cost is small (Ponder polls for new blocks, the events on a
factory + clones are sparse).

## Netlify

### Branch + preview deploys

By default Netlify restricts deploys to the production branch. To get
PR / branch previews:

1. Site → Settings → Build & deploy → Branches → set "Branch deploys"
   to **All** (or a specific allowlist).
2. Watch paths default to "all changes" — fine.

### Environment variable scoping

Set `DATABASE_URL` and `INDEXER_SCHEMA` with **all** contexts selected
(production + deploy-preview + branch-deploy). If you only set them on
production, your preview deploys behave like the cache layer doesn't
exist (which is the kill-switch behavior — but probably not what you
want for testing).

### Avoid `restoreSiteDeploy` for env changes

If you change an env var, don't use Netlify's "republish" or the
`restoreSiteDeploy` API to test it. That promotes an old build artifact
that was built before the env var existed. Always trigger a fresh build
(push a commit, or use `createSiteBuild` with the branch param).

### `ALCHEMY_API_KEY` not `NEXT_PUBLIC_ALCHEMY_MAINNET_URL`

The proxy reads the API key server-side and constructs the upstream URL
itself. **Don't** set the URL with a `NEXT_PUBLIC_` prefix — that
inlines it into the client bundle, which is the leak we're trying to
prevent.

## Verification end-to-end

After deploy:

```bash
# 1. RPC proxy is up + allowlist works
curl -s -X POST https://YOUR.SITE/api/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
# Expect: {"jsonrpc":"2.0","id":1,"result":"0x..."}

curl -s -X POST https://YOUR.SITE/api/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"debug_traceCall","params":[]}'
# Expect: -32601 Method not allowed

# 2. API key not in client bundle
grep -rl "YOUR_API_KEY_HERE" .next/static
# Expect: no output (zero files)

# 3. After hitting a token page, pgCache populated
psql $DATABASE_URL -c "SELECT key FROM cache_entries ORDER BY updated_at DESC LIMIT 5;"
# Expect: rows like auction:0x…, ens:0x…, token-metadata:0x…
```

For Ponder verification, see [`ponder/README.md`](./ponder/README.md).

## Cost expectations

Order-of-magnitude for the production setup, low traffic:

```txt
Netlify          $0–19/mo  (free tier covers small sites)
Railway          $5–10/mo  (Postgres add-on)
Railway          $5–10/mo  (Ponder service)
RPC provider     varies; with the cache layer most repeat traffic skips
                 RPC entirely
```

Total recurring infra: roughly **$10–25/mo** for the data layer beyond
whatever the host + RPC provider already charge.

## Kill switches

Each layer has one. Listed in dependency order — disabling an upper
layer only affects that layer; lower layers keep working.

```txt
INDEXER_DISABLED=1        skip Ponder reads; web app falls through
                          to pgCache + RPC.

DATABASE_URL unset        pgCache no-ops; indexer reads return null.
                          App behaves as if neither layer exists.

Method allowlist          /api/rpc rejects anything outside the
                          standard read/write set. Tightening it
                          further is one PR away.

Per-IP rate limit         Caps `/api/rpc` at 240 calls/min per IP;
                          `/api/auction/revalidate` at 30/min/IP.
                          Tunable in the route handlers.
```

## Local dev

The full stack runs locally if you want it:

```bash
# Postgres in Docker
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:15

# Apply the migration
echo "DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres" \
  >> apps/web/.env.local
npm run db:migrate

# Run the web app
npm run dev
```

Ponder locally is more involved — see [`ponder/README.md`](./ponder/README.md).
For most frontend changes you don't need Ponder running locally; the
indexer-first wrappers fall through to the cached RPC path on miss.
