# PND v2 — From-Scratch Rebuild

> **Historical design doc.** This is the rebuild plan, written before the
> work landed. It predates the final layout: the indexer lives at
> `apps/indexer/` (not `ponder/`), and the `lazy_*` web-side tables it
> discusses were removed, not kept. The plan's *intent* — "store, not
> cache; web reads Postgres, worker owns chain scanning" — is what
> shipped. For the system as it actually exists, read `ARCHITECTURE.md`;
> treat this file as rationale/history.

## Context

The existing PND codebase at `/Users/dd/foundation` has evolved into a
multi-tier architecture (pgCache → Ponder → lazy_* tables → eager RPC)
where the bottom tier — eager RPC fallback on cache miss — has historically
run up unexpected Alchemy bills. The team has already migrated some artist-
token indexing from web-side scans into Ponder (migrations 027–030), but
the old fallback paths remain in code (~16K LOC in `apps/web/src/lib/`),
the `lazy_*` tables are misleadingly named (most are permanent stores, not
caches), and the architecture lacks a single source of truth per question.

At the product's actual scale (~150 known artists, ~100 visits/day), the
right shape is not "more layers of fallback" but "fewer tables, one writer
per table, web app never touches chain for storable data." This rebuild
implements that shape as a clean break: a new repo at a new path, built
alongside production, deployed to Railway as a single project with five
services, cut over by DNS when stable.

**The invariant the system is designed around:**

> Token data is stored permanently in Postgres. The web app never refetches
> on cache miss. The web app never triggers a chain read for artist tokens,
> metadata, ENS, contract identity, transfer history, or any other data
> that can be stored. The worker keeps stored data fresh; the web reads.

**Outcome:** RPC spend bounded by `known_artists` count, not by traffic.
~3× smaller codebase. New platforms onboard by adding one scanner + one
table, not by extending three god-modules.

---

## Architecture

### Five services, one Railway project, one Postgres

```
┌─────────────────────────────────────────────────────────────────┐
│ Railway project: pnd-v2                                          │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │   web    │  │  indexer │  │  worker  │                       │
│  │ Next.js  │  │  Ponder  │  │  Node    │                       │
│  │ long-run │  │ (PND +   │  │ (scans + │                       │
│  │          │  │ Catalog +│  │ owners + │                       │
│  │          │  │ FND mkt +│  │ metadata │                       │
│  │          │  │ shared   │  │ + ENS)   │                       │
│  │          │  │ NFTs)    │  │          │                       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                       │
│       │             │             │                              │
│       └─────────────┼─────────────┘                              │
│                     │                                            │
│            ┌────────▼──────┐                                     │
│            │   Postgres    │                                     │
│            └───────────────┘                                     │
└─────────────────────────────────────────────────────────────────┘
```

No Netlify. No scheduled functions. No cron config. No separate metadata-
warmer service (folded into worker). The drpc.org-free-tier RPC strategy
for Ponder and the `known_artists` view concept carry over.

### Ponder indexer scope (7 contracts)

**Per-clone fanout (state machines):**
- `SovereignAuctionHouseFactory` + factory-spawned `SovereignAuctionHouse` clones (PND auctions)
- `NFTMarket` at `0xcDA72070E455bb31C7690a170224Ce43623d0B6f` (Foundation marketplace)
- `FoundationNFT` at `0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405` (shared 1/1)
- `SuperRareNFT` at `0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0` (shared 1/1)
- `Catalog` at `0x467a9c39e03C595EC3075D856f19C7386b6b915d`

**Discovery-only (one row per artist-deploys-a-clone, NO per-clone events):**
- `NFTCollectionFactoryV1` + V2 → `fnd_collections` table
- `MintFactory` → `mint_creators` table
- `TLUniversalDeployer` → `tl_creators` table

**Dropped entirely** (replaced by worker scanners): `SuperRareBazaar`,
`TransientAuctionHouse`, `FoundationCollection` clones, `MintCollection`
clones, `TLCollection` clones.

### Worker tasks (single Node process, internal scheduler)

| Task | Interval | Purpose |
|---|---|---|
| `seed-known-artists` | startup + 1h | Materialize known_artists from Ponder sources + manual seed |
| `warm-contract-identity` | 10m | `name()`/`symbol()`/`supportsInterface` per new contract; one-time per contract |
| `warm-ens` | 10m | ENS reverse + avatar per known artist; per-collector on-demand from transfer scan |
| `warm-metadata` | 1m active / 5m idle | Resolve tokenURI + IPFS; folds in current `apps/metadata-warmer` |
| `scan-fnd-collections` | 10m | Per-artist Transfer-from-zero scan on each FoundationCollection clone (sourced from `fnd_collections`) |
| `scan-mint-clones` | 10m | Per-artist TransferSingle/Batch from-zero scan on Mint clones (sourced from `mint_creators`) |
| `scan-tl-clones` | 10m | Per-artist Transfer-from-zero scan on TL clones (sourced from `tl_creators`, ERC721 only) |
| `scan-manifold` | 30m | Per-artist Etherscan + Alchemy scan; ports current `scanManifoldArtistTokens` |
| `scan-token-transfers` | 5m | Per-contract Transfer scan for tokens in `artist_tokens`; updates `token_owners`, appends `token_transfers` |
| `resolve-new-token-owner` | event-triggered | When a new `artist_tokens` row lands, single `ownerOf` call to populate `token_owners` (prevents "owner null" window) |
| `ponder-drift-check` | 1h | Compare `pnd_houses` count vs `ponder_sync.factory_addresses`; alert on drift |

All tasks gate on `isKnownArtist(addr)` for any per-artist work, and on
`isKnownContract(addr)` for any per-contract work derived from
`artist_tokens`.

### Data model (three table families)

**`pnd_*`, `fnd_*`, `catalog_*`, `srv2_artist_tokens`, `mint_creators`, `tl_creators` — Ponder-owned**

Rebuildable from chain. Same column shapes as today's Ponder schema —
port the existing [ponder/ponder.schema.ts](ponder/ponder.schema.ts)
verbatim, minus the dropped marketplace tables (`srv2Auctions`,
`tlAuctions`, `mintArtistTokens`, `tlArtistTokens`).

**Worker-owned permanent stores:**

```
artist_tokens
  (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
  PK (contract, token_id), INDEX (artist), INDEX (platform, mint_block DESC)

token_owners
  (contract, token_id, owner, transferred_at_block, transferred_at_time, tx_hash)
  PK (contract, token_id), INDEX (owner)
  -- Inverse index powers /collector/[address] without external API calls

token_transfers
  (contract, token_id, from_addr, to_addr, block_number, log_index, tx_hash, block_time)
  PK (contract, token_id, tx_hash, log_index)
  INDEX (contract, token_id, block_number DESC)

token_metadata
  (contract, token_id, name, description, image_url, animation_url, raw_uri, fetched_at)
  PK (contract, token_id)
  -- Carry forward from existing schema. Permanent.

contract_identity
  (address, name, symbol, has_bytecode, is_erc721, is_erc1155, fetched_at)
  PK (address), INDEX (fetched_at)
  -- Carry forward from existing schema.

ens_identities
  (address, ens_name, avatar_url, resolved_at)
  PK (address)
  -- Carry forward from existing schema.

worker_cursors
  (task, scope, last_block, last_run_at)
  PK (task, scope)

worker_iterations
  (id, task, started_at, finished_at, scope_count, rpc_calls, rows_written, ok, error)
  -- Audit log. Powers /admin dashboards + cost alerting.

artist_seeds
  (address, source, added_at, notes)
  PK (address)
  -- Manual artist additions outside the Ponder-derived sources.
```

**TTL'd cache:**

```
cache_entries (key, value JSONB, expires_at, updated_at)
  -- Only for: live auction state, on-demand RPC for non-PND active auctions, buy prices.
```

**`known_artists` view:** rebuild as UNION over `pnd_houses.owner`,
`fnd_collections.creator`, `fnd_artist_tokens.creator`, `mint_creators.address`,
`tl_creators.sender`, `catalog_*.artist`, `artist_seeds.address`. Pattern
established in [db/migrations/022_known_artists_view.sql](db/migrations/022_known_artists_view.sql) — port the dynamic-schema-detection logic so it survives Ponder schema bumps.

---

## Repo structure

Fresh repo at `/Users/dd/foundation-v2/` (or whatever the user prefers).

```
foundation-v2/
├── apps/
│   ├── web/                # Next.js, long-running on Railway
│   │   ├── src/app/        # ports of every existing route
│   │   ├── src/components/ # ports of existing components
│   │   └── src/lib/
│   │       ├── reads.ts          # typed SELECTs for every page query
│   │       ├── cache.ts          # pgCache wrapper (port)
│   │       ├── onchain.ts        # ~6 functions for genuinely-mutable state
│   │       ├── pinning/          # IPFS pinning, copied verbatim
│   │       ├── crawler.ts        # copied verbatim
│   │       └── db.ts             # postgres.js client; max bumped to 20
│   ├── indexer/            # Ponder, 7 contracts
│   │   ├── ponder.config.ts
│   │   ├── ponder.schema.ts
│   │   └── src/            # handlers per kept contract
│   └── worker/             # Node, single process
│       ├── src/index.ts    # task scheduler + HTTP /jobs surface
│       ├── src/tasks/      # one file per task above
│       └── src/scanners/   # per-platform incremental scan logic
├── packages/
│   ├── abi/                # copied verbatim from existing
│   ├── addresses/          # copied verbatim
│   ├── shared/             # copied verbatim
│   └── token-metadata/     # copied verbatim
├── contracts/              # copied verbatim from existing
├── db/
│   ├── migrate.mjs         # Node migration runner (port from existing)
│   └── migrations/         # NEW clean numbered series, ~12 files total
├── scripts/                # fork helpers, ABI emit, etc.
├── templates/
│   └── artist-page/        # copied verbatim
├── railway.json            # per-service deploy config
└── package.json
```

**No `lazy_*` anywhere.** No `external-indexer.ts`. No `lazy-index.ts`. No
Netlify directory. No `apps/metadata-warmer/` (folded into worker).

---

## Critical files

### Files to copy verbatim (low-risk, well-tested, audit-confirmed live)

- `contracts/` — Sovereign Auction House, factory. Already deployed on
  mainnet at `0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f`; do not redeploy.
- `packages/abi/` — hand-written ABIs with const assertions
- `packages/addresses/` — chain-pinned contract addresses
- `packages/shared/` — site config, IPFS utilities
- `packages/token-metadata/` — `resolveTokenMetadata` helper used by warmer
- `templates/artist-page/` — per-artist site template (synced to ripe0x/sovereign-artist-site)
- `apps/web/src/lib/pinning/` — Pinata/4EVERLAND/Filebase client-side pinning
- `apps/web/src/lib/crawler.ts` — bot UA detection
- `apps/web/src/lib/import-sources/` — external-registry adapters for `/artist/[address]/import`
- `apps/web/src/lib/funding-works-supporters.ts` — Footer SupportersList data
- `apps/web/src/lib/parseEthAmount.ts` (+ test) — bid/reserve input parsing
- `apps/web/src/lib/v2-activity.ts` + `v2-activity-types.ts` — server-side activity event enrichment (batch ENS + avatar resolves)
- Client-side hooks (used by components, copy verbatim): `useSellerListings`, `useSequentialCancel`, `useEthAmountInput`, `useGodMode`, `useOptimizedImage`, `useIpfsFallback`
- `apps/web/src/components/` (all subdirectories) — UI components
- `apps/web/src/app/*` page-level JSX/copy (data wiring rewritten, presentation unchanged)
- `scripts/fork-fast-forward.mjs`, `scripts/fork-reclaim-token.mjs`, `scripts/emit-sovereign-abi.mjs`
- `apps/metadata-warmer/src/` (logic, repackaged as a worker task)

### Files to port with modifications

- [ponder/ponder.config.ts](ponder/ponder.config.ts) — drop SuperRareBazaar, TransientAuctionHouse, FoundationCollection clones, MintCollection clones, TLCollection clones. Keep everything else.
- [ponder/ponder.schema.ts](ponder/ponder.schema.ts) — drop `srv2Auctions`, `tlAuctions`, `mintArtistTokens`, `tlArtistTokens`. Keep everything else.
- [ponder/src/index.ts](ponder/src/index.ts) — port handlers for kept contracts (~600 of the current 762 lines). Drop SuperRareBazaar handlers (lines ~537–639), TransientAuctionHouse handlers (lines ~646–762), FoundationCollection per-clone Transfer handler (lines ~484–503). Drop [ponder/src/Mint.ts:53–99](ponder/src/Mint.ts:53) (MintCollection handlers) and [ponder/src/TL.ts:69–94](ponder/src/TL.ts:69) (TLCollection handlers).
- [apps/web/src/lib/db.ts](apps/web/src/lib/db.ts) — bump `max` from 2 to 20 (long-running, no sandbox fanout).
- [apps/web/src/lib/pg-cache.ts](apps/web/src/lib/pg-cache.ts) — port as-is.
- [apps/web/src/lib/single-flight.ts](apps/web/src/lib/single-flight.ts) — replace with in-memory `Map<string, Promise>` (long-running web doesn't need DB locks).
- [apps/web/src/lib/manifold-discovery.ts](apps/web/src/lib/manifold-discovery.ts) — port the `scanManifoldArtistTokens` logic into `apps/worker/src/scanners/manifold.ts`; drop the orchestration wrapper.
- [db/migrations/022_known_artists_view.sql](db/migrations/022_known_artists_view.sql) — port the dynamic-schema-detection pattern into the new `known_artists` view migration.
- [apps/metadata-warmer/src/index.ts](apps/metadata-warmer/src/index.ts) — port loop body into `apps/worker/src/tasks/warm-metadata.ts`.
- [apps/web/src/lib/dependency-check.ts](apps/web/src/lib/dependency-check.ts) (673 lines) — feeds `/dependency/[address]`. Port the report-building shape, but rewrite each per-platform lookup to read from new Postgres tables (`artist_tokens`, `contract_identity`, `fnd_collections`, `mint_creators`, `tl_creators`, `catalog_*`) instead of doing live RPC + Alchemy NFT API + platform-adapter calls. The page-level shape (inventory totals, contract map, platform coverage) stays; the data wiring underneath becomes pure SELECTs.
- [apps/web/src/lib/contract-classifier.ts](apps/web/src/lib/contract-classifier.ts) (290 lines) — used by dependency-check.ts for contract-type classification. Port the classification logic, but read cached results from `contract_identity` first; the worker's `warm-contract-identity` task populates that table so dep-check is pure SELECT in steady state.
- [apps/web/src/lib/artist-inventory.ts](apps/web/src/lib/artist-inventory.ts) — internal to dependency-check; port alongside.
- [apps/web/src/lib/seller-listings.ts](apps/web/src/lib/seller-listings.ts) (220 lines) — feeds delist + migrate flows. Port the cancellable-listing shape, but rewrite the underlying read to JOIN `fnd_auctions` + `fnd_buy_nows` (Ponder-owned) filtered by seller + status='active'. No more SR Bazaar log scan; SR listings come from on-demand `getActiveSrV2AuctionMap` (the `onchain.ts` function). Same UI contract.
- [apps/web/src/lib/seller-listings-server.ts](apps/web/src/lib/seller-listings-server.ts) — port the cache-key + revalidation surface; underlying read replaced as above.

### Files / routes NOT to port (deleted in v2)

Infrastructure / gravity wells:
- `apps/web/src/lib/lazy-index.ts` (1858 lines)
- `apps/web/src/lib/onchain-discovery.ts` (1436 lines — keep ~300 lines of metadata resolution as `lib/onchain.ts`; drop the rest)
- `apps/web/src/lib/external-indexer.ts`
- `apps/web/src/lib/manifold-discovery.ts` orchestration wrapper (scan logic moves to worker)
- `apps/web/netlify/` (no Netlify)
- `netlify.toml` (no Netlify)
- `db/migrations/*` (entire 30-file series; replaced by ~12 clean migrations)
- All `lazy_*` tables (never created in v2)
- `apps/web/src/lib/indexer-queries.ts` half (port only functions that read still-existing Ponder tables; drop `*FromIndexer` wrappers for dropped tables)

API routes:
- `apps/web/src/app/api/cron/*` (worker owns scheduling)
- `apps/web/src/app/api/auction/revalidate/route.ts` — audit confirmed zero callers
- The internal logic of `apps/web/src/app/api/refresh-artist/[address]/route.ts` is replaced by a thin proxy that forwards to `POST <worker>/jobs/refresh-artist/:address` (the public URL stays the same so RefreshButton.tsx still works without changes)

User-facing routes:
- `apps/web/src/app/index-prev/` — preserved-but-unlinked legacy grid landing; zero UI links in production
- `apps/web/src/app/collector/[address]/` — orphan route; zero UI links anywhere in codebase

Lib modules superseded by worker tables:
- `apps/web/src/lib/lazy-*` paths (none should exist in v2)
- `apps/web/src/lib/platforms/*-scan.ts` (the worker now owns all scan logic)

---

## Build order (6 phases)

### Phase 0 — Foundations (1–2 days)

- Init `foundation-v2/` repo, monorepo workspace config (pnpm or npm).
- Provision Railway project + Postgres.
- Copy forward `contracts/`, `packages/*`, `templates/`, all UI components, IPFS pinning, crawler detection, fork scripts. One-shot copy script committed to history.
- Stand up `apps/web/`, `apps/indexer/`, `apps/worker/` as stubs (each builds and starts cleanly with no business logic).
- Port `db/migrate.mjs` and run against empty Postgres.
- Set up shared TS config, ESLint, Prettier.

**Verify:** `pnpm -r build` is green. `node db/migrate.mjs` is a no-op against empty DB. Each app's "hello world" deploys to Railway and the healthcheck returns 200.

### Phase 1 — Schema + Ponder (2–3 days)

- Write ALL Postgres migrations up front (~12 files). The full schema lands in one pass; no incremental ALTERs accumulating across migrations later. Forces you to confront cross-table joins before pages exist.
  - 001: `pnd_*` tables (managed by Ponder, declared via `ponder.schema.ts`; SQL migration is just the schema name allocation)
  - 002: `fnd_*` + `catalog_*` + `srv2_artist_tokens` + `mint_creators` + `tl_creators` (same — Ponder-managed)
  - 003: `artist_tokens`
  - 004: `token_owners`
  - 005: `token_transfers`
  - 006: `token_metadata`
  - 007: `contract_identity`
  - 008: `ens_identities`
  - 009: `worker_cursors`, `worker_iterations`
  - 010: `artist_seeds`
  - 011: `cache_entries`
  - 012: `known_artists` view (dynamic-schema-detection pattern from current migration 022/028)
- Port `apps/indexer/` from current `ponder/`. Drop the contracts and tables listed under "Files to port with modifications" above. Confirm only the 7 kept contracts remain in `ponder.config.ts`.
- Deploy Ponder to Railway. Let it backfill from PND factory deploy block. Watch for the multi-address `eth_getLogs` pattern working against drpc.org free tier (load-bearing, verified in existing config comments).
- Add a lifecycle hook in `apps/indexer/src/index.ts` that writes a sentinel row to a new `_indexer_state` table when backfill completes (`is_backfilled=true`, `last_block=<block>`). The worker will poll this before starting any task that depends on Ponder data.

**Verify:** Pick 3 known artists, write raw SQL against Ponder tables that returns their auctions, sales, and catalog records. Compare against Etherscan. Confirm `_indexer_state.is_backfilled = true` lands.

### Phase 2 — Worker (5–7 days, longest phase)

Build tasks in dependency order:

1. **`seed-known-artists`** — port [db/migrations/022](db/migrations/022_known_artists_view.sql) view definition; add `artist_seeds` as one of the UNION inputs. Runs on worker startup + every hour. Until this returns non-empty for the seeded artists, no other task should run.
2. **`warm-contract-identity`** — cheap, no chain history scan. Reads every unique `contract` from `pnd_auctions`, `fnd_auctions`, `artist_tokens` (when populated), `catalog_contracts`. Multicall `supportsInterface` + `name()`/`symbol()`. Write to `contract_identity`. Skip rows already present.
3. **`warm-ens`** — per known artist + per address seen as `winner` in `pnd_auctions` / `buyer` in `fnd_sales`. Slow background loop.
4. **`scan-fnd-collections`** — reads `fnd_collections.creator` from Ponder. For each (artist, collection) where artist ∈ known_artists, scan `Transfer(from=0x0, to=*)` on the collection from `worker_cursors` forward. Write rows to `artist_tokens` with `platform='fnd-collection'`. Advance cursor.
5. **`scan-mint-clones`** — same pattern, reads `mint_creators`. ERC-1155 TransferSingle/Batch from-zero.
6. **`scan-tl-clones`** — same pattern, reads `tl_creators` filtered to `cType LIKE 'ERC721%'`. ERC-721 Transfer-from-zero.
7. **`scan-manifold`** — port from [apps/web/src/lib/manifold-discovery.ts](apps/web/src/lib/manifold-discovery.ts). Per-artist Etherscan `txlist` + Alchemy `getAssetTransfers`. Cursor per `(artist, 'manifold')`. Write to `artist_tokens` with `platform='manifold'`.
8. **`resolve-new-token-owner`** — event-triggered: when steps 4–7 INSERT a new `artist_tokens` row, also enqueue an immediate `ownerOf(tokenId)` call to write `token_owners`. Prevents the "row exists but owner column is null" window. Implementation: same task, called from the INSERT path of each scanner; one extra RPC per new mint discovered.
9. **`scan-token-transfers`** — for each distinct `contract` in `artist_tokens`, run `getLogs(Transfer)` from cursor. Apply to `token_owners` (UPSERT) and `token_transfers` (INSERT). Critical optimization (from Plan agent): for the first-time backfill of a contract, start cursor at `MIN(mint_block) FROM artist_tokens WHERE contract = $1` rather than contract deploy block — sidesteps the multi-year Foundation NFT shared contract scan.
10. **`warm-metadata`** — port from [apps/metadata-warmer/src/index.ts](apps/metadata-warmer/src/index.ts). Find rows in `artist_tokens` without `token_metadata` entries. Resolve via `resolveTokenMetadata` (already in `packages/token-metadata`).
11. **`ponder-drift-check`** — port from [apps/web/src/app/api/cron/indexer-drift-check/route.ts](apps/web/src/app/api/cron/indexer-drift-check/route.ts) — manual INSERT into `ponder_sync.factory_addresses` when drift detected.

Worker process structure: single Node process, `setInterval`-driven, internal `Map<TaskName, { lastRun, running }>` for dedup. Bounded per-task concurrency (start with 4 parallel scans per task). Healthcheck on `:8080/health` returns task-level lag from `worker_iterations`.

Add HTTP surface:
- `POST /jobs/refresh-artist/:address` — dedup: if address already in queue, no-op. Triggered by web's "Refresh my work" button.
- `GET /health` — task lag + last-iteration ok/error.
- `GET /metrics` — rpc_calls/rows_written per task over last 24h.

**Verify:** After 4–6 hours of worker runtime, for the seeded artist set:
- `SELECT count(*) FROM artist_tokens` should be in the hundreds-to-low-thousands.
- `SELECT count(*) FROM token_owners WHERE owner IS NULL` should be 0.
- `SELECT count(*) FROM token_metadata WHERE name IS NOT NULL` should match `count(*) FROM artist_tokens` minus a small unresolved-IPFS tail.
- Spot-check: pick one artist, list their tokens, confirm count + provenance match what `/artist/<X>` shows in v1.

### Phase 3 — Web app (7–10 days)

Port every user-facing route. Data wiring is rewritten; presentation reuses components verbatim.

**Module structure under `apps/web/src/lib/`:**
- `reads.ts` — typed query functions per page need: `getArtistTokens(addr, page, pageSize)`, `getArtistIdentity(addr)`, `getActiveAuctionsForArtist(addr)`, `getTokenDetail(contract, tokenId)`, `getCollectorTokens(addr)`, `getCatalogForArtist(addr)`, `getActivityFeed(cursor, limit)`, `getPlatformStats()`. Each is a pure Postgres SELECT.
- `cache.ts` — pgCache wrapper (port from current `pg-cache.ts`).
- `onchain.ts` — the small set of genuinely-mutable reads that need fresh chain state:
  - `getActiveAuctionState(contract, tokenId)` — current bid amount + end time; 30s pgCache
  - `getBuyPrice(contract, tokenId)` — Foundation buy-now price; 30s pgCache
  - `getActiveSrV2AuctionMap(artist)` — filtered `getLogs(seller=artist)` on SR Bazaar; 30s pgCache; only fires on artist-page render
  - `getActiveTlAuctionMap(artist)` — same shape for TL
  - `getCurrentOwner(contract, tokenId)` — single `ownerOf` for token detail page when `token_owners` row is older than X; 60s pgCache
  - That's it. Six functions. No fallback chains.
- `db.ts` — postgres.js client, `max: 20`.

**Routes to port** (full live surface day 1, per user direction — confirmed via audit of what is actually linked in the live UI):

Core product:
- `/` — activity feed (reads `getActivityFeed` + `getPlatformStats`)
- `/artist/[address]` — artist gallery (reads `getArtistTokens` + `getArtistIdentity` + on-demand active-auction map per platform)
- `/[handle]/[tokenId]` — token detail (reads `getTokenDetail` JOINing `artist_tokens`, `token_metadata`, `contract_identity`, `token_owners`, `token_transfers`; on-demand `getCurrentOwner` if stale)

Artist self-service (linked from navbar "For artists" menu, from artist page, or from migration/delist banners):
- `/preserve` — IPFS pinning flow; uses existing client-side keys pattern
- `/delist` — bulk delist tool landing
- `/auction/new` — Sovereign house deployment
- `/sites` — self-hosted site template landing
- `/artist/[address]/migrate` — Foundation cancellation + Sovereign relisting flow (linked from MigrationBanner on artist page)
- `/artist/[address]/import` — catalog batch-import planner from external registries (linked from artist page + log)

Catalog + dependency (linked from artist page + log):
- `/catalog` — catalog landing
- `/catalog/[address]` — per-artist catalog read/edit
- `/dependency` — dependency report entry (search form)
- `/dependency/[address]` — artist systems audit

Static / explainer (linked from navbar or footer):
- `/about` — project info (footer)
- `/guides` — guide hub (navbar + footer)
- `/guides/delist` — delist how-to (linked from /guides)
- `/auctions` — artist-owned auction contracts explainer (linked from /guides)
- `/log` — build timeline (footer)

**Explicitly NOT ported (audit confirmed dead/orphaned):**
- `/index-prev` — preserved-but-unlinked legacy grid landing; zero UI links; only reachable via direct URL. **Drop.**
- `/collector/[address]` — zero UI integration anywhere in the codebase; no navbar/footer/page links; effectively dead route. **Drop.** (The underlying capability — inverse query on `token_owners` — still gets built into `lib/reads.ts` for future use, since it's free given the schema, but no page consumes it on day 1.)

**API routes to port** (each wraps a `reads.ts` function or proxies to the worker):
- `GET /api/activity` — paginated activity feed (called by ActivityFeedClient infinite scroll)
- `GET /api/artist/[address]/tokens` — paginated artist gallery (called by ArtistGallery, SovereignBulkPanel)
- `GET /api/artist/[address]/preserve-tokens` — preserve-flow token list
- `GET /api/artist/[address]/ens-url` — ENS field for SitePanel
- `GET /api/meta/[contract]/[tokenId]` — token metadata + CDN image (called by LazyAuctionCard, useTokenInfo)
- `GET /api/contract-info/[address]` — contract metadata for Catalog add form
- `GET /api/catalog/[address]` — Catalog read for paginated UI
- `POST /api/catalog/[address]/revalidate` — Catalog cache flush after on-chain write (called by useCatalogWrite, useCatalogMulticall)
- `GET /api/dependency/[address]` — dependency report
- `GET /api/seller-listings/[address]` — cancellable Foundation + SR listings (called by useSellerListings)
- `POST /api/seller-listings/revalidate` — flush after cancel (called by BulkDelistPanel, MigratePanel)
- `GET /api/revalidate` — gallery cache flush (called by ArtistHeader refresh pill)
- `POST /api/rpc` — JSON-RPC proxy for client-side wagmi reads/writes (called by SovereignBulkPanel for bulk listing writes; still needed because client-side wagmi can't share the server-side API key)
- `POST /api/refresh-artist/[address]` — thin proxy that forwards to worker `POST /jobs/refresh-artist/:address` (called by RefreshButton)

**API routes explicitly NOT ported:**
- `POST /api/auction/revalidate` — audit confirmed zero callers in the codebase. **Drop.**
- Entire `/api/cron/*` directory (`cleanup`, `refresh-external-indexes`, `indexer-drift-check`) — worker owns all scheduled work in v2.

**Auction state freshness for non-PND platforms:** the `onchain.ts` functions are the only place chain reads happen on user-driven requests. They run only on artist-page and token-page renders, gated by 30s pgCache, gated by crawler-UA filter. At 100/day with crawler filtering, this is bounded to ~tens of calls per day.

**Verify per route:** for each ported route, manually load the page against the new stack and compare to v1 production output. Use 5–10 known artists across all platforms (FND-only, SR-only, multi-platform, no-tokens, brand-new).

### Phase 4 — Pre-cutover hardening (2–3 days)

- Load-test web app at 10× peak traffic (target ~1000 requests/hour). Confirm DB pool sized correctly, no slow queries, pgCache hit rate >90%.
- Worker chaos: kill the worker process mid-iteration. Restart. Confirm cursors resume correctly, no duplicate rows, no orphaned `_iterations` rows.
- Run `worker-doctor` CLI: for each task, last-run, rows-touched, current cursor, lag-vs-head. All tasks should report < expected interval lag.
- Run `ponder-drift-check` manually. Confirm zero drift after a fresh `pnd_houses` deploy via the local fork helper.
- Pick 20 spot-check artists across platforms. Compare v1 vs v2: tokens, active auctions, last sales, catalog entries, ENS, owner state.
- Deploy v2 behind a temporary domain (`v2.<production-domain>`). Run for 48h under low-but-real traffic. Watch Alchemy + Postgres metrics for cost ceiling.

### Phase 5 — Cutover (1 day)

- Cut DNS from production domain to v2 stack.
- Keep v1 running on the old infrastructure for 7 days as rollback safety.
- Watch Railway metrics + Alchemy dashboard for 48 hours post-cutover.
- After 7 days clean: decommission v1 (delete Netlify site, the old Railway Ponder + warmer services, drop the old Postgres if it's separate).

---

## Reusable patterns and helpers

The Plan agent and the architecture review surfaced several patterns from
the existing repo worth carrying forward unchanged:

- **`isKnownArtist(addr)` gate** ([apps/web/src/lib/known-artists.ts](apps/web/src/lib/known-artists.ts)) — fails-closed pattern. Port as worker module; every scanner gates on it.
- **`withTimeout(fn, ms)`** ([apps/web/src/lib/indexer-queries.ts:49](apps/web/src/lib/indexer-queries.ts:49)) — wraps potentially-slow reads so a slow Postgres can't add latency to renders. Port as `lib/reads.ts` utility.
- **`unstable_cache` + `pgCache` two-tier read pattern** — port as-is. L1 in-process + L2 Postgres.
- **Per-IP rate limit** ([apps/web/src/lib/rate-limit.ts](apps/web/src/lib/rate-limit.ts)) — apply to `/api/rpc` (still needed for client-side wagmi RPC reads in `useReadContract` for live bid amounts).
- **drpc.org for Ponder** — strategy documented in [ponder/README.md](ponder/README.md), preserve.
- **The `_v1`/`_v2` schema-bump pattern** for Ponder — preserve. The new repo starts on `ponder_v1` again; subsequent schema changes bump.
- **`isCrawler` user-agent gate** ([apps/web/src/lib/crawler.ts](apps/web/src/lib/crawler.ts)) — apply at every route that does on-demand RPC.
- **Activity feed cursor-paginated UNION** ([apps/web/src/lib/indexer-queries.ts:710](apps/web/src/lib/indexer-queries.ts:710)) — port largely as-is, drop the SR/TL branches (those tables no longer exist).

---

## Verification (end-to-end)

After each phase, the corresponding row of this table should be green
before moving on:

| Phase | Verification |
|---|---|
| 0 | `pnpm -r build` green; Railway healthchecks pass; migrate is no-op on empty DB |
| 1 | Ponder `_indexer_state.is_backfilled=true`; SQL spot-check on 3 artists matches Etherscan |
| 2 | `artist_tokens` populated for known set; `token_owners.owner IS NULL` count = 0; `worker-doctor` shows all tasks current |
| 3 | Every v1 user-facing route loads and matches v1 output for 5–10 spot-check artists |
| 4 | 10× load test passes; chaos test on worker; v2 stack stable for 48h on shadow domain |
| 5 | DNS cut; Alchemy + Postgres metrics flat post-cutover for 48h |

**Cost invariant check** (run weekly post-launch): query the `rpc_events`
audit table (port from existing schema) — total daily RPC volume should
be bounded by `known_artists count × 4 platforms × (24h / scan_interval)`
plus a small constant for `onchain.ts` on-demand reads. Any deviation
points to a scanner cursor regression or an unguarded fallback path.

---

## Out of scope for this rebuild

- Multi-chain support. Single chain (Ethereum mainnet) — same as today.
- New product features. Pure architecture rebuild; user-facing surface unchanged.
- New Sovereign Auction House contract. The existing factory at `0xaE71...` stays.
- IPFS pinning provider changes. Client-side keys + Pinata/4EVERLAND/Filebase stay.
- Switching frameworks (Next.js stays, Ponder stays, Postgres stays).
- A real job queue (Redis/BullMQ). At this scale, the `setInterval` + cursor pattern is sufficient. Revisit if worker can't keep up.

---

## Risks called out by the Plan agent

1. **First-time `token_owners` window.** Mitigation: event-triggered `resolve-new-token-owner` (task 8 above) runs on every `artist_tokens` insert.
2. **Worker starts before Ponder backfill completes.** Mitigation: all worker tasks that depend on Ponder data check `_indexer_state.is_backfilled = true` before running; otherwise sleep and re-poll.
3. **`token_transfers` backfill on Foundation NFT shared contract.** Mitigation: start cursor at `MIN(mint_block)` from `artist_tokens` for that contract, not contract deploy. Bounds the historical scan to tokens we care about.
4. **Single worker process saturation.** Mitigation: per-task concurrency knob (default 4). If a task can't keep up, raise concurrency; if multiple can't keep up, the worker is genuinely too small and we revisit (queue/worker pool/etc.). Don't predict the wrong scale.
5. **Activity feed depends on Ponder being current.** Acceptable per invariant #5 (no fallback chains). UI shows "activity feed unavailable" banner if `getActivityFeed` returns null.
6. **New-artist discovery latency.** Worst case ~20 min from sign-up to inventory visible (10min discovery cycle + 10min token-transfers cycle). The "Refresh my work" button (`POST /jobs/refresh-artist`) bypasses both cycles for known artists; for brand-new artists, document a CLI command (`pnpm worker:refresh <address>`) for operator use.
