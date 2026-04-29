# PND auction indexer (Ponder)

Optional event indexer for the Sovereign Auction House factory + every
clone it spawns. Writes to the same Postgres the web app's pgCache uses,
under the `ponder` schema by default.

The web app falls back to direct RPC when Ponder isn't running, so this
service is opt-in. It earns its keep on `getActiveAuctionCount` (one
SQL `COUNT` instead of a deploy-block-to-tip log scan + N parallel
contract reads) and as the foundation for any future cross-cutting
queries — collector pages, "auctions ending soon", activity feeds.

## What it indexes

```txt
SovereignAuctionHouseFactory   discovers new clones via factory pattern
SovereignAuctionHouse (× N)    every clone the factory has emitted
                                indexed automatically via Ponder's
                                `factory()` helper
```

Events tracked, mapped to write targets in [`src/index.ts`](src/index.ts):

```txt
AuctionCreated                 → INSERT into pnd_auctions
AuctionBid                     → INSERT into pnd_bids; update pnd_auctions
AuctionEndTimeUpdated          → update pnd_auctions.end_time
AuctionReservePriceUpdated     → update pnd_auctions.reserve_price
AuctionEnded                   → set pnd_auctions.status = 'settled'
AuctionCanceled                → set pnd_auctions.status = 'cancelled'
```

Schema is in [`ponder.schema.ts`](ponder.schema.ts). Two tables:

```txt
ponder.pnd_auctions    one row per (house, auctionId), state-machine'd
                       in place. Indexed on (seller, status) and
                       (token_contract, token_id).

ponder.pnd_bids        immutable bid log. Indexed on (auction_id,
                       block_number).
```

## Required env

```txt
DATABASE_URL              same Postgres the web app uses
DATABASE_SCHEMA           required by Ponder ≥ 0.16. Set to "ponder"
                          so the web app's INDEXER_SCHEMA matches.
PONDER_RPC_URL_1          mainnet JSON-RPC URL. See "RPC requirements"
                          below — not every public endpoint works.
```

## RPC requirements (this is the main gotcha)

Ponder uses the `factory()` pattern to track all clones. Every poll
cycle, it issues `eth_getLogs` calls with **multiple addresses** in the
`address` array (one per known clone).

Public RPC providers vary in how they handle this:

```txt
✅ drpc.org                       handles multi-address arrays cleanly
✅ Alchemy                        same
❌ publicnode.com                 rejects "blocked parameter:
                                  params.0.address.#"
⚠️  Your own node                 depends on the client's eth_getLogs
                                  filter handling
```

Use drpc as the default if you don't already have an Alchemy / Infura
key. Don't point this at the web app's own `/api/rpc` proxy — the
allowlist there intentionally blocks the bulk-`getLogs` patterns that
Ponder's sync needs.

## Required: src/api/index.ts

Ponder ≥ 0.16 refuses to start without `src/api/index.ts` even if you
don't expose anything over HTTP. The file is a tiny Hono app at
[`src/api/index.ts`](src/api/index.ts) — leave it alone unless you
actually want a custom HTTP surface.

If Ponder logs `BuildError: API endpoint file not found`, this is the
file that needs to exist.

## Deploying

### Railway

The included [`railway.json`](railway.json) configures the service to
use Nixpacks with `npm install && npm run codegen` for build and
`npm start` for run.

1. Create a new service in your Railway project.
2. Source: connect this repo, set **Root Directory** to `ponder`.
3. Add env vars: `DATABASE_URL`, `DATABASE_SCHEMA=ponder`,
   `PONDER_RPC_URL_1`.
4. Deploy.

Initial sync of the factory + clones takes ~30s for a few thousand
blocks of activity. After backfill, Ponder polls for new blocks every
5s. Postgres grows as new auctions land — bounded by total event
volume.

### Other hosts

Anywhere that runs a long-lived Node 20+ process. Don't run it in a
serverless function — it's a continuously-syncing process with
streaming state.

## Recovery: schema is locked

If you redeploy with a config change and Ponder fails with:

```txt
MigrationError: Schema "ponder" was previously used by a different
Ponder app. Drop the schema first, or use a different schema.
```

Ponder tracks "what app version owns this schema" in metadata; a
shape-incompatible redeploy refuses to overwrite it. Recovery is
manual:

```sql
DROP SCHEMA IF EXISTS ponder CASCADE;
DROP SCHEMA IF EXISTS ponder_sync CASCADE;
```

Then redeploy. Ponder will recreate both schemas from scratch and
re-sync from `FACTORY_DEPLOY_BLOCK`. Re-sync is fast.

## Verification

```sql
-- Is Ponder caught up + serving?
SELECT value FROM ponder._ponder_meta WHERE key = 'app';
-- Look for: "is_ready": 1

-- How many auctions has it indexed?
SELECT count(*), status FROM ponder.pnd_auctions GROUP BY status;

-- How many factory clones discovered?
SELECT count(*) FROM ponder_sync.factory_addresses;

-- Latest synced block (per chain)
SELECT chain_id, max(end_block) FROM ponder_sync.intervals GROUP BY chain_id;
```

Healthy state: `is_ready=1`, `factory_addresses` matches the number of
houses on chain, `pnd_auctions` row count grows as new auctions land,
no error log spam in the service logs.

## Local dev

```bash
cd ponder
npm install
DATABASE_URL=postgresql://postgres:dev@localhost:5432/postgres \
DATABASE_SCHEMA=ponder \
PONDER_RPC_URL_1=https://eth.drpc.org \
  npm run dev
```

`ponder dev` runs the indexer with hot reload. Sync against drpc
takes seconds for the small event volume.

If you want the web app to read from your local Ponder, set
`INDEXER_SCHEMA=ponder` and `DATABASE_URL` (the same one Ponder
uses) in `apps/web/.env.local`.

## What's not in here

- **Foundation NFTMarket events** (auctions, sales, bids on the legacy
  Foundation marketplace). Out of scope for v1; would be a second
  contract registration in `ponder.config.ts` if added later.
- **Token metadata / IPFS pinning**. Lives elsewhere in the stack
  (the web app + IPFS gateways). Ponder doesn't touch metadata.
- **Per-artist lazy backfill** for non-protocol contracts (Manifold
  creator extensions, custom contracts). The original plan had this;
  we deliberately deferred. The web app uses the Alchemy NFT API for
  per-artist Manifold discovery — see
  [`apps/web/src/lib/manifold-discovery.ts`](../apps/web/src/lib/manifold-discovery.ts).

## Cost

At PND's current event volume:

```txt
Postgres storage   < 100MB for years
Sync RPC calls     bounded by chain activity; tiny
Service uptime     ~$5-10/mo on Railway, similar on Render/Fly
```

Most of the cost story is "is Ponder running?" not "how much is it
indexing?" — the bottleneck is wall-clock uptime, not throughput.
