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
PONDER_RPC_URL_1          OPTIONAL. Paid Alchemy / Infura URL used as a
                          last-resort fallback. Leave unset in normal
                          operation — see "RPC strategy" below.
```

## RPC strategy

[`ponder.config.ts`](ponder.config.ts) wires the chain transport to
viem's `fallback()` with a chain of **free public RPCs first**, and
`PONDER_RPC_URL_1` (if set) appended at the end as a last-resort
safety net:

```txt
1. https://ethereum-rpc.publicnode.com   (primary)
2. https://eth.llamarpc.com              (fallback)
3. https://rpc.ankr.com/eth              (fallback)
4. $PONDER_RPC_URL_1                     (last-resort, only if set)
```

This is deliberate. The indexer's RPC profile — periodic head-following
polls + per-block sync state cached in Postgres — fits inside what free
public providers comfortably serve. Save paid Alchemy CU for the
user-facing app, where rate limits and reliability actually bite.

**Why a chain instead of one provider:** Ponder uses the `factory()`
pattern to track all clones, so every poll issues `eth_getLogs` calls
with **multiple addresses** in the `address` array. Public providers
disagree on how big an address list they accept — llamarpc and ankr
sometimes reject the wider arrays, publicnode handles them. The
fallback chain rotates on rejection so individual provider quirks
don't stall sync. Expect a small number of `WARN  Received JSON-RPC
error` lines in the logs during heavy backfill — that's the rotation
working, not a failure.

**Don't point this at the web app's own `/api/rpc` proxy** — the
allowlist there intentionally blocks the bulk-`getLogs` patterns that
Ponder's sync needs.

**If you must use a paid provider as primary** (e.g. private chain,
custom node), edit `ponder.config.ts` to put your URL ahead of
`PUBLIC_RPCS` in the fallback array. Don't just set the env var
expecting it to take precedence — by design it sits at the end of
the chain.

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
3. Add env vars: `DATABASE_URL`, `DATABASE_SCHEMA=ponder`.
   `PONDER_RPC_URL_1` is optional and should normally be left unset
   (see "RPC strategy"). The public-RPC fallback chain in
   `ponder.config.ts` is sufficient on its own.
4. Deploy.

Initial sync of the factory + clones runs against the public-RPC
fallback chain. Backfill from `FACTORY_DEPLOY_BLOCK` takes on the
order of an hour for the first deploy as it scans 7+ months of logs
across all factory clones. After backfill, Ponder head-follows at
the cadence set by `pollingInterval` (currently 60s; see
`ponder.config.ts:65`). Steady-state RPC volume is bounded by chain
activity and clone count — small enough to serve from public
providers indefinitely. Postgres grows as new auctions land —
bounded by total event volume.

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
  npm run dev
```

`ponder dev` runs the indexer with hot reload against the public-RPC
fallback chain — no RPC env var needed. A full local backfill from
`FACTORY_DEPLOY_BLOCK` takes ~1h on public RPCs; once it's caught up,
head-following is fast.

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
Sync RPC calls     $0 — served from the public-RPC fallback chain
Service uptime     ~$5-10/mo on Railway, similar on Render/Fly
```

Most of the cost story is "is Ponder running?" not "how much is it
indexing?" — the bottleneck is wall-clock uptime, not throughput.

> **History note.** Before the public-RPC fallback chain landed, the
> indexer pointed at a paid Alchemy URL via `PONDER_RPC_URL_1` and was
> burning ~273K requests/day at a sustained ~238 CU/s. That was ~99%
> of the project's Alchemy traffic — orders of magnitude more than the
> user-facing app, which only emits RPC on cold cache misses. If you
> see Alchemy CU climbing again after a deploy, check that this
> service isn't somehow back on a single-provider transport.
