# What's done, what's left

> **Historical snapshot.** This tracked the v2 rebuild as it was being
> built. The "Not done yet" items below — Manifold scanner body, SR/TL
> active-auction maps, ERC-1155 stats, the web data-fetch rewire — have
> since shipped (the stack is in production on maglev/Netlify+Railway;
> see worker `tasks/scan-manifold.ts`, `scan-srv2-active-auctions.ts`,
> `scan-tl-active-auctions.ts`, `scan-1155-stats.ts`). Kept for history.
> `ARCHITECTURE.md` describes the current system. Also note: the PLAN.md
> reference below points at a `~/.claude/plans/...` path, but the plan is
> checked in at the repo-root `PLAN.md`.

Phase 0 + Phase 1 + Phase 2 + Phase 3 lib port + local-deploy verification
all landed. The full stack boots end-to-end against a local Postgres:
migrations apply, Ponder backfills, worker ticks, web app serves HTTP 200
on home/about/artist/api routes.

What's left is the deferred work (Manifold scanner body, SR/TL active-
auction maps, ERC-1155 stats) and the real Railway deploy.

## Local-deploy verification (completed)

Five real runtime bugs surfaced + fixed during a full local boot:

1. Root `package.json` missing `postgres` dep (db/migrate.mjs import
   failed at load).
2. Migration 011 (`known_artists` view) threw on fresh DB because
   Ponder's schema doesn't exist yet — now creates a bootstrap view
   over `artist_seeds` only and logs a NOTICE to re-run after Ponder.
3. Worker `start` script wasn't loading `.env`; added
   `--env-file-if-exists=.env`.
4. `warm-metadata` + `ponder-drift-check` tasks queried Ponder tables
   without the `ponder_v1.` schema prefix; added schema qualification +
   "skip when Ponder schema doesn't exist yet" guards.
5. `warm-metadata` SQL returned `token_id` (snake_case) but Candidate
   type used `tokenId` (camelCase) — caused `BigInt(undefined)` on
   every tick. Fixed with `token_id AS "tokenId"` quoted alias.

These were all caught by actually running the stack against postgres@15
locally. Pure typecheck would never have surfaced them. The first real
Railway deploy should be smooth-er for it.

## Done (committed)

- ✅ Phase 0: monorepo scaffold (pnpm workspaces), shared tsconfig,
  .gitignore, README, .env.example per service, root db/migrate.mjs.
- ✅ Phase 0: verbatim copies — contracts/, packages/{abi,addresses,
  shared,token-metadata}, templates/artist-page/, all UI components,
  IPFS pinning, crawler detection, all React hooks, import-sources.
- ✅ Phase 0: all three app stubs build cleanly (apps/web,
  apps/indexer, apps/worker).
- ✅ Phase 1: 11 SQL migrations covering every public-schema table
  (artist_tokens, token_owners, token_transfers, token_metadata,
  contract_identity, ens_identities, worker_cursors, worker_iterations,
  artist_seeds, cache_entries, known_artists view).
- ✅ Phase 1: Ponder port — config (7 contracts, 3 discovery-only),
  schema (drops srv2Auctions / tlAuctions / mintArtistTokens /
  tlArtistTokens), full handlers for PND + FND NFTMarket + FND shared
  1/1 + SR shared 1/1 + Catalog + MintFactory + TLUniversalDeployer
  discovery + FND collection factories.
- ✅ Phase 1: Ponder-readiness check via `_ponder_meta.is_ready` poll
  in scheduler.ts (avoids needing an indexer-side sentinel).
- ✅ Phase 2: worker process scaffold — scheduler with 10 scheduled
  tasks + refresh-artist queue, in-memory dedup, `/health` + `/metrics`
  + `/jobs/refresh-artist/:address` HTTP surface, postgres + viem
  clients, graceful shutdown.
- ✅ Phase 2: 11 task implementations (seed-known-artists,
  warm-contract-identity, warm-ens, warm-metadata, scan-fnd-collections,
  scan-mint-clones, scan-tl-clones, scan-manifold [stub],
  scan-token-transfers, ponder-drift-check, refresh-artist).
- ✅ Phase 2: 3 scanner modules — transfer-from-zero (ERC-721),
  erc1155-mints, resolve-owner (event-triggered ownerOf fill).
- ✅ Phase 3: web `lib/db.ts` (max=20 for long-running),
  `lib/single-flight.ts` (in-memory Map), `lib/reads.ts` (typed SELECTs
  — the entire data-fetching surface), `lib/onchain.ts` (six functions
  for genuinely-mutable state), `lib/lazy-index.ts` no-op shim,
  `lib/onchain-discovery.ts` slim (metadata-resolution + Postgres-read
  versions of discoverArtistTokenRefs / enrichTokens),
  `lib/manifold-discovery.ts` stub, `lib/external-indexer.ts` worker-
  proxy shim.
- ✅ Phase 4: railway.json per service (web, indexer, worker).
- ✅ Phase 5: CUTOVER.md.

## Not done yet (per-area todo)

### Phase 2 follow-up: Manifold scanner full port

`apps/worker/src/scanners/manifold.ts` is a no-op stub. Port the body
from `apps/worker/src/_imported-from-warmer/manifold-discovery.ts`
(copied verbatim from v1 for reference). The Etherscan `txlist` +
multicall `supportsInterface` + Alchemy `alchemy_getAssetTransfers`
flow is unchanged; only the DB wiring needs rewiring to write
`artist_tokens` (platform='manifold') + `lazy_manifold_contracts`-
equivalent (an `artist_contracts` cache table — add as migration 012
if needed, or fold into `artist_tokens`).

### Phase 3: web app data-fetching rewire

The copied lib/* files (artist-queries, artist-cache, auctions,
catalog, dependency-check, indexer-queries, last-sale,
seller-listings*, platforms/*, etc.) are v1 verbatim. They COMPILE
because the dropped-module imports resolve to shims, but their bodies
still reference the v1 multi-tier fallback pattern. The rewire path:

1. **For each lib module**, rewrite the public function bodies to
   call `lib/reads.ts` functions instead of the lazy_* paths.
   - `artist-queries.ts` → `getArtistTokens` (reads.ts)
   - `artist-cache.ts` → wrap reads.ts functions in `unstable_cache`
   - `auctions.ts` → split PND reads (from reads.ts) from non-PND
     live state (from onchain.ts)
   - `catalog.ts` + `catalog-cache.ts` → reads.ts:getCatalogForArtist
   - `dependency-check.ts` → reads.ts queries + contract_identity
   - `indexer-queries.ts` → port subset, drop *FromIndexer wrappers
     for dropped Ponder tables (srv2Auctions, tlAuctions, etc.)
   - `last-sale.ts` → reads.ts:getLastSale
   - `platforms/*.ts` → drop scan code; keep type definitions + the
     `cancel-calls.ts` write helpers (used by delist flow)
   - `seller-listings.ts` + `seller-listings-server.ts` → reads.ts +
     onchain.ts:getBuyPrice
   - `contract-classifier.ts` + `contract-identity-store.ts` →
     reads.ts + worker writes; no on-demand classification

2. **For each app/api/* route handler**, replace v1's lib calls with
   the corresponding reads.ts or onchain.ts call. Most routes are
   thin (~30 lines); the rewire is mechanical.

3. **For each app/<route>/page.tsx**, the components and JSX are
   untouched. Only the data-fetching imports at the top need to point
   at the new lib functions. The most common rewire:
   - `import { getArtistGalleryPage } from "@/lib/artist-queries"`
     → keep the import; rewrite the function body in artist-queries.ts.
   - `import { discoverArtistTokenRefs } from "@/lib/onchain-discovery"`
     → already redirected in the new onchain-discovery.ts shim;
     verify call sites get the expected shape.

4. **Verify per route**: load each user-facing route against the v2
   stack, compare to v1 production. Spot-check 5–10 known artists
   across platforms.

Estimated effort: 7–10 focused days. The architecture is locked; this
is mechanical rewiring with a small surface (~40 lib files, ~15 routes,
~25 pages).

### Phase 3: SR V2 + TL active-auction maps

`lib/onchain.ts:getActiveSrV2AuctionMap` and `getActiveTlAuctionMap`
are stubs returning empty maps. Port the body from v1's
`apps/web/src/lib/auctions.ts:getArtistSovereignAuctionMap` (same
shape — filtered getLogs on seller topic + multicall to confirm
still-active). 30s pgCache wrapper; gated by `isCrawler` at call sites.

### Phase 4 follow-up: Dockerfiles (optional)

Railway's Nixpacks works for all three services as configured. If
you want explicit Dockerfiles for reproducibility or to deploy to
non-Railway hosts (Fly, Render, Kubernetes), add `apps/<svc>/Dockerfile`.
The build commands in `railway.json` are the recipe.

### Phase 5 follow-up: post-cutover cleanup

Tracked in CUTOVER.md.

## Reading order for the next contributor

1. README.md — what the system is, how to run it locally.
2. PLAN.md (in `/Users/dd/.claude/plans/great-create-a-plan-ancient-kazoo.md`)
   — the architectural rationale; the invariants the system enforces.
3. apps/indexer/ponder.config.ts + ponder.schema.ts — the load-bearing
   data definitions.
4. apps/worker/src/scheduler.ts — the heartbeat that keeps every
   permanent store fresh.
5. apps/web/src/lib/reads.ts + onchain.ts — the data-fetching contract
   the web app reads against.
6. db/migrations/*.sql — every public-schema table, in order.

## The invariant (read every time you touch the web app)

> Token data is stored permanently in Postgres. The web app never
> refetches on cache miss. The web app never triggers a chain read for
> storable data. The worker keeps stored data fresh; the web reads.

If a PR adds an `eth_getLogs` call to anything under `apps/web/`, it's
violating the invariant. The only exception is `lib/onchain.ts` — and
even there, only the six functions defined today. New entries to that
file require explicit discussion.
