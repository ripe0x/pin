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
DATABASE_SCHEMA           required by Ponder ≥ 0.16. Currently
                          "ponder_v1" — the web app's INDEXER_SCHEMA
                          must match. Bump on every schema-changing
                          release; see "Versioned schema upgrades"
                          below.
PONDER_RPC_URL_1          REQUIRED. drpc.org free tier works in
                          production for this indexer (verified on
                          mainnet with 76+ factory clones at 300s
                          polling). See "RPC strategy" below for why
                          drpc and not publicnode/llamarpc/ankr/Alchemy.
```

## RPC strategy

**Use drpc.org's free tier (`https://eth.drpc.org`), throttled by
`pollingInterval` for cost control.** Indexer cost is $0.

This took some debugging to land on. The full picture, in case you're
applying it to a different Ponder project:

### What goes wrong with the obvious options

**Free public RPCs (publicnode, llamarpc, ankr) — broken.** Ponder's
`factory()` pattern issues `eth_getLogs` calls with up to **50
cloned addresses** bundled in the `address` array (hardcoded slice in
`node_modules/ponder/src/sync-historical/index.ts:188`, no config knob
in v0.16 — the constant is unchanged on `main`, no upstream issue
filed). publicnode returns `"blocked parameter: params.0.address.#"`;
llamarpc and ankr return non-JSON HTML error responses (`Unexpected
token M in JSON…` is the failure mode you'll see in the Ponder log).
A `viem.fallback()` chain across these does NOT help — every request
exhausts retries before falling through to whatever endpoint actually
serves it, and total CU spend is unchanged.

**Alchemy on the free / Growth tier — fragile.** Ponder's poll volume
scales with `(contract surface) × (factory clone count) × (1 /
pollingInterval)`. As clones accumulate (we hit 76 on mainnet), the
multi-address `eth_getLogs` queries grow, and the **per-call CU cost
grows with them**. We burned through a monthly Alchemy cap in a single
afternoon — not visible until Alchemy starts returning HTTP 429 with
the body `Monthly capacity limit exceeded.` (the literal "M" the JSON
parser chokes on). When that happens Ponder won't even pass the
startup `eth_chainId` diagnostic.

**Quicknode / Infura paid tiers — fine but unnecessary.** Same shape
of bill as Alchemy, fewer surprises maybe, but you're paying real
money for what drpc free tier does for $0.

### What actually works

**drpc.org free tier handles factory-pattern multi-address `eth_getLogs`
correctly.** Verified on mainnet with this project's contract
surface (5 base contracts + 76 Sovereign clones + N Foundation
collection clones, factory-discovered). Zero rate-limits hit, zero
HTTP errors, sub-100ms median response.

**Cost is then controlled by `pollingInterval`** (`ponder.config.ts`,
chain config). Per-poll RPC volume scales linearly with the contract
surface; reducing poll frequency reduces total request volume
proportionally:

```
Default (5s polling)    : ~17K polls/day  → impractical at any scale
60s polling             : 1,440 polls/day → fine on paid, marginal on free
300s polling (current)  : 288   polls/day → comfortable on drpc free
600s polling            : 144   polls/day → ample headroom
```

The trade-off is **how stale your indexer can be**. At 300s the
activity feed / "ending soon" lists may be up to 5 min behind chain
reality. For an auction site this is mostly fine because the bid
button reads fresh on-chain state at click-time and the contract
rejects stale bids — but UI surfaces showing `endTime` for auctions
in their final 30 min should fall through to a chain-side "freshen"
read. (See the activity-feed implementation for how this is layered.)

### Watch for re-syncs

The CU baseline you observe is for **steady-state head-following**.
If Ponder restarts and isn't fully caught up, it runs flat-out
ignoring `pollingInterval` until backfill = 100%. A Postgres reset,
a `MigrationError: Schema is locked` recovery, or any change that
forces re-sync from `FACTORY_DEPLOY_BLOCK` will spike RPC volume
hard for the duration. Look for `Updated backfill indexing progress`
in the service logs; if you see it, you're in backfill, not steady
state, and current CU/s is not representative.

### Don't point this at your app's `/api/rpc` proxy

The allowlist on a typical web-app RPC proxy intentionally blocks
the bulk-`getLogs` patterns that Ponder's sync needs, and the proxy's
rate limit will fight initial sync. Ponder needs a direct upstream.

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
3. Add env vars: `DATABASE_URL`, `DATABASE_SCHEMA=ponder_v1`,
   `PONDER_RPC_URL_1=https://eth.drpc.org` (see "RPC strategy" for
   why this and not Alchemy / publicnode / etc.). The `_v1` suffix
   leaves room for zero-downtime schema bumps later — see
   "Versioned schema upgrades" below.
4. Deploy.

Initial sync of the factory + clones takes on the order of an hour
for the first deploy as it scans 7+ months of logs across all factory
clones. After backfill, Ponder head-follows at the cadence set by
`pollingInterval` (currently 300s; see `ponder.config.ts`).
Steady-state RPC volume is bounded by clone count and poll frequency.
Postgres grows as new auctions land — bounded by total event volume.

### Other hosts

Anywhere that runs a long-lived Node 20+ process. Don't run it in a
serverless function — it's a continuously-syncing process with
streaming state.

## Versioned schema upgrades

Whenever `ponder.schema.ts` or `ponder.config.ts` changes shape
(new table, removed table, factory address change, new contract
entry), Ponder ≥ 0.16 refuses to start with:

```txt
MigrationError: Schema "ponder_v1" was previously used by a different
Ponder app. Drop the schema first, or use a different schema.
```

This is a safety check — Ponder won't silently overwrite a schema
that another build owns. Bump the version instead of dropping:

1. **Pick the next version.** If current `DATABASE_SCHEMA=ponder_v1`,
   the next is `ponder_v2`.
2. **Update `db/migrations/022_known_artists_view.sql`** — the
   `ponder_schema` constant near the top points at the live schema.
   Bump it to the new value.
3. **Update the code default** in
   `apps/web/src/lib/indexer-queries.ts` — search for
   `INDEXER_SCHEMA ?? "ponder_v1"` and bump the literal. The env
   var is the source of truth in production; the default exists
   for fresh local-dev setups.
4. **Set `DATABASE_SCHEMA=ponder_v2` on the indexer** (Railway
   variables → ponder service). Trigger a fresh deploy with
   `railway up --service ponder` — `redeploy` reuses the cached
   image and won't pick up env-var changes that the build needs.
5. Wait for the new schema to backfill to head (`Completed backfill
   indexing across all chains` in the logs). Verify with the
   queries in "Verification" below, pointed at the new schema.
6. **Set `INDEXER_SCHEMA=ponder_v2` on the web app** (Netlify env
   → all contexts) and trigger a redeploy. Web app now reads from
   the new schema.
7. **Re-run the migration** so `known_artists` is rebuilt against
   the new schema:
   ```bash
   echo "$(cat db/migrations/022_known_artists_view.sql)" | \
     railway connect Postgres
   ```
8. **Drop the old schema** once the new one is verified in
   production:
   ```sql
   DROP SCHEMA IF EXISTS ponder_v1 CASCADE;
   ```
   `ponder_sync` is shared and stays — Ponder reuses the cached
   chain data across schema versions.

If you skip the version bump and the old schema isn't compatible,
the recovery is to drop both schemas and re-sync from
`FACTORY_DEPLOY_BLOCK` — slow and costs RPC. Stick with the
versioned-deploy flow above.

## Verification

```sql
-- Is Ponder caught up + serving?
SELECT value FROM ponder_v1._ponder_meta WHERE key = 'app';
-- Look for: "is_ready": 1

-- How many auctions has it indexed?
SELECT count(*), status FROM ponder_v1.pnd_auctions GROUP BY status;

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
DATABASE_SCHEMA=ponder_v1 \
PONDER_RPC_URL_1=https://eth.drpc.org \
  npm run dev
```

`ponder dev` runs the indexer with hot reload. A full local backfill
from `FACTORY_DEPLOY_BLOCK` takes on the order of an hour; once
caught up, head-following is fast.

If you want the web app to read from your local Ponder, set
`INDEXER_SCHEMA=ponder_v1` and `DATABASE_URL` (the same one Ponder
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
Sync RPC calls     $0 — drpc.org free tier (see "RPC strategy")
Service uptime     ~$5-10/mo on Railway, similar on Render/Fly
```

If you ever need to dial cost down further (paid endpoint, larger
chain surface, etc.), the lever is `pollingInterval` in
`ponder.config.ts`. Going from 300s → 600s halves the request
volume; bid-list freshness shifts from "up to 5 min late" to "up to
10 min late" — fine for a non-realtime auction site.

> **History note (kept for portability — same problem will hit any
> Ponder project that uses factory pattern + tries to save on RPC).**
> Started on a paid Alchemy endpoint and was burning ~273K
> requests/day at ~238 CU/s — orders of magnitude more than the
> user-facing app. Tried fronting Alchemy with a viem `fallback()`
> chain of free public RPCs (publicnode → llamarpc → ankr); did not
> work because Ponder bundles up to 50 cloned addresses per
> `eth_getLogs` call and those providers all reject multi-address
> arrays at that size. Discovered (the hard way, after Alchemy's
> monthly cap blew) that **drpc.org's free tier handles the
> multi-address pattern correctly**, and combined with a 300s poll
> interval, indexer cost goes to $0 with zero operational
> downsides. If Alchemy CU climbs unexpectedly on a future
> migration, check whether `pollingInterval` was lowered or whether
> the indexer is in a re-sync (look for `Updated backfill indexing
> progress` in the service logs).
