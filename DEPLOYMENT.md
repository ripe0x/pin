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
4. Set `PONDER_RPC_URL_1=https://eth.drpc.org` (drpc.org's free tier
   handles Ponder's factory-pattern multi-address `eth_getLogs` calls
   correctly; publicnode / llamarpc / ankr do not — see
   [`ponder/README.md`](./ponder/README.md#rpc-strategy) for the full
   failure mode). Cost is controlled via `pollingInterval` in
   `ponder.config.ts`, currently 300s.
5. Set `INDEXER_SCHEMA=ponder` on the web app so it knows where
   Ponder writes.

Ongoing cost is small (Ponder polls for new blocks, the events on a
factory + clones are sparse).

## External-platform indexer (Manifold / SuperRare V2 / Transient Labs)

The three external NFT platforms aren't indexed by Ponder — that would
mean polling tens of thousands of contracts globally, with cost that
scales with the platform's whole user base rather than your ecosystem.
Instead, per-artist data is pulled from Alchemy NFT API + Etherscan on
demand, written to Postgres, and served from there. The architecture
is "store, not cache" — written rows persist; refresh happens on
explicit triggers, not on TTL expiry.

The single mechanism that bounds cost is the **known-artist gate**:
anonymous crawler traffic against `/artist/<random>` produces zero
Alchemy spend because the adapter declines to call external APIs for
addresses outside the `known_artists` view.

### Membership: `known_artists` view

Defined in [`db/migrations/022_known_artists_view.sql`](./db/migrations/022_known_artists_view.sql).
An address counts as "known" iff any of these is true:

- Deployed a Sovereign Auction House (`pnd_houses.owner`)
- Deployed a Foundation collection contract (`fnd_collections.creator`)
- Minted on Foundation, shared contract or own collection
  (`fnd_artist_tokens.creator`)
- Declared work in the on-chain Catalog (`catalog_contracts.artist`,
  `catalog_tokens.artist`, or `catalog_ranges.artist`)

The view is a UNION over Ponder-managed tables. New artists join the
set automatically when Ponder picks up their on-chain action. No
sync step required.

The migration is defensive: catalog branches are only included if
the corresponding `ponder.catalog_*` tables exist at migration time
(catalog support is a newer Ponder schema addition). If your Ponder
deployment predates catalog, the view runs with FND + PND sources
only. After deploying catalog-aware Ponder, write a follow-up
migration that re-runs the same `CREATE OR REPLACE VIEW` to pick up
the catalog branches.

To extend later (e.g., manual opt-in, collector recognition), UNION
additional sources into the view — no downstream code changes needed.

### Files

- [`db/migrations/022_known_artists_view.sql`](./db/migrations/022_known_artists_view.sql)
  — the view definition
- [`apps/web/src/lib/known-artists.ts`](./apps/web/src/lib/known-artists.ts)
  — `isKnownArtist(address)` gate, fails closed on DB error
- [`apps/web/src/lib/external-indexer.ts`](./apps/web/src/lib/external-indexer.ts)
  — `refreshArtist`, `refreshAllKnownArtists`, `maybeRefreshArtistIfStale`
- [`apps/web/src/app/api/cron/refresh-external-indexes/route.ts`](./apps/web/src/app/api/cron/refresh-external-indexes/route.ts)
  — daily cron endpoint
- Adapters: [`platforms/manifold.ts`](./apps/web/src/lib/platforms/manifold.ts),
  [`platforms/superrareV2.ts`](./apps/web/src/lib/platforms/superrareV2.ts),
  [`platforms/transient.ts`](./apps/web/src/lib/platforms/transient.ts),
  [`manifold-discovery.ts`](./apps/web/src/lib/manifold-discovery.ts)
  — each calls `isKnownArtist` before any external API.

### Triggers

Two ways a refresh fires:

1. **On-visit, stale-while-revalidate.** Server components for
   `/artist/[address]` and `/catalog/[address]` call
   `void maybeRefreshArtistIfStale(address)` near the top of the
   render. No-op for unknown addresses; no-op within the 1-hour
   stale window; otherwise fire-and-forget background refresh.
   Page renders with current data while the refresh writes update
   rows for the next visit. Placed after the crawler check on
   `/artist/` so bot traffic doesn't drive refresh frequency.

2. **Daily cron.** `POST /api/cron/refresh-external-indexes` iterates
   every row in `known_artists` and refreshes all three platforms
   per artist. Schedule once daily; the route is idempotent and
   safe to re-run.

### Scheduling the cron

Wired via a Netlify Scheduled Function that POSTs to the secret-gated
Next.js route. No third-party cron service needed.

- Function: [`apps/web/netlify/functions/refresh-external-indexes-cron.ts`](./apps/web/netlify/functions/refresh-external-indexes-cron.ts)
- Schedule: configured in [`netlify.toml`](./netlify.toml) under
  `[functions."refresh-external-indexes-cron"]`, currently `0 4 * * *`
  (04:00 UTC daily).

Required env on Netlify:
- `URL` — auto-set by Netlify to the site's primary URL
- `REVALIDATE_SECRET` — same secret used by `/api/cron/cleanup` and
  `/api/cron/indexer-drift-check`

The serial loop over known artists can take several minutes for
1000+ artists; the underlying route sets `maxDuration = 300` so a
function-host timeout doesn't kill it mid-run.

Manual invocation for ad-hoc refreshes (no scheduler needed):

```bash
curl -X POST 'https://<your-host>/api/cron/refresh-external-indexes?secret=$REVALIDATE_SECRET'
```

### Cost ceiling

Per-artist refresh: ~150–1500 Alchemy CU spread across the three
platforms. At 100–500 known artists × daily cron:

| View size | Daily cron cost | On-visit ceiling (1h stale × full traffic) |
|---|---|---|
| 100 artists | ~$0.07/month | $5.40/month worst case |
| 500 artists | ~$1.10/month | $27/month worst case |
| 1,000 artists | ~$2.25/month | $54/month worst case |

The "worst case" assumes a crawler hits every known-artist URL every
hour for a month and triggers a refresh each time — unrealistic but
it's the ceiling. Practical cost is much closer to "daily cron
total" because most known artists aren't visited every hour.

To tighten the ceiling further, raise the stale threshold in
`STALE_THRESHOLD_MS` in `external-indexer.ts` (currently 1h) — at
24h, the on-visit ceiling drops by ~24× and effectively converges
on the daily cron cost.

### Verification

After running the migration and deploying the route:

```sql
-- 1. Sanity-check the view size
SELECT COUNT(*) FROM known_artists;

-- 2. Spot-check membership for a known artist
SELECT 1 FROM known_artists WHERE address = lower('0x<your-test-artist>');

-- 3. After visiting their /catalog page, verify their status rows refreshed
SELECT
  (SELECT last_indexed_at FROM lazy_manifold_artist_status WHERE creator = lower('0x...')),
  (SELECT last_indexed_at FROM lazy_srv2_artist_status     WHERE creator = lower('0x...')),
  (SELECT last_indexed_at FROM lazy_tl_artist_status       WHERE creator = lower('0x...'));
```

### Kill switch

If anything goes wrong with the external indexer, the existing
`INDEXER_DISABLED=1` env var doesn't apply (it targets Ponder reads).
The three external paths fail closed: if `DATABASE_URL` is unset the
gate returns `false` and no external API calls fire. To temporarily
stop all external-indexer writes without redeploying:

```sql
-- Drop the view → isKnownArtist returns false → adapters short-circuit.
-- Reads from existing lazy_*_artist_tokens rows continue serving.
DROP VIEW IF EXISTS known_artists;
```

Restore by re-running migration 022.

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
