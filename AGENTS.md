# PND v2 — Agent / contributor onboarding

Read this before writing code. It captures the things that have burned
people who reconstructed the architecture from stale docs or a stale
local env. `ARCHITECTURE.md` is the accurate deep-dive; this is the
skimmable map + the traps.

## Monorepo layout

```
apps/web      Next.js. Reads Postgres ONLY. Never scans the chain for
              storable data. The only live-chain reads are the ~6 fns in
              src/lib/onchain.ts (active bids, current owner, live SR/TL
              auction maps). Everything else is a Postgres SELECT.
apps/worker   Node. Owns ALL per-token chain scanning + enrichment.
              Writes the public-schema tables web reads: artist_tokens,
              token_owners, token_transfers, token_metadata,
              token_1155_stats, token_1155_mints, contract_identity,
              ens_identities, worker_cursors/iterations.
apps/indexer  Ponder. DISCOVERY ONLY for the long tail (which artist
              deployed which contract): mint_creators, tl_creators,
              fnd_collections — plus fully-indexed fixed contracts
              (pnd_*, fnd_*, srv2_artist_tokens, catalog_*). Writes the
              ponder_v1 schema.
```

`git log` shows the v2 rebuild that established this split: PR #69
("v2 rebuild: web reads from Postgres, worker owns all chain scanning",
commit `3aa1636`). That PR renamed the old top-level `ponder/` directory
to `apps/indexer/`.

## The load-bearing rule: discovery (Ponder) vs token-scanning (worker)

This split is a deliberate cost decision, not an accident.

- **Ponder** can subscribe to a fixed, small set of contracts and index
  them forever. It is *bad* at the long tail — there are thousands of
  artist-deployed Manifold/Mint/TL clones and Ponder can't watch
  thousands of addresses.
- **The worker** scans the long tail incrementally, gated on the
  `known_artists` view (the spend ceiling — only ~155 addresses that
  took an on-chain ecosystem action get scanned).

**Do NOT move per-token / per-clone indexing into Ponder.** Full
token-indexing in Ponder is exactly the unbounded backfill the rebuild
removed on purpose. To add or extend per-artist platform indexing,
**extend the worker scanner** (`apps/worker/src/tasks/scan-*.ts` +
`apps/worker/src/scanners/*`), writing `public.artist_tokens` gated on
`isKnownArtist`. Only add a contract to Ponder when it's a fixed,
shared contract you want indexed for everyone. See
`docs/adding-a-platform.md`.

### Platforms PND currently indexes

Surfaced to artists in the Catalog import flow (the "PND's sources"
tooltip on `/studio/[address]/catalog`) and in the refresh button on
the same studio page (`RefreshButton`); `/catalog/[address]` is the
read-only public record. Adding a platform → bump all three.

- **Foundation** — `apps/worker/src/tasks/scan-fnd-collections.ts` for
  artist-deployed FND collections, plus the shared `FoundationNFT` 1/1
  contract subscription in `apps/indexer/ponder.config.ts`
  (`fnd_artist_tokens`).
- **Manifold** — `apps/worker/src/tasks/scan-manifold.ts`
  (+ `apps/worker/src/scanners/manifold.ts`).
- **Mint** — `apps/worker/src/tasks/scan-mint-clones.ts`.
- **SuperRare** — V2 shared `SuperRareNFT` contract subscription in
  `apps/indexer/ponder.config.ts` (`srv2_artist_tokens`).
- **Transient Labs** — `apps/worker/src/tasks/scan-tl-clones.ts`.

The canonical list for the web app lives in
`apps/web/src/lib/indexed-platforms.ts`. Keep that file, the worker
scanners, and the Ponder config in sync when you add a platform.

### MURI (preservation overlay, NOT a mint platform)

MURI is the on-chain media-permanence protocol PND surfaces and lets
artists mint into. It is a **fixed shared singleton**
(`0x0000000000C2A0B63ab4aA971B08B905E5875b01`), so it's indexed in Ponder
(`MURIProtocol` subscription in `ponder.config.ts`, handlers in
`apps/indexer/src/MURI.ts` → `muri_tokens` + `muri_contracts`), not the
worker. It is deliberately NOT in `indexed-platforms.ts` — it's a
preservation overlay on top of other platforms' tokens, not a mint source.
Full notes: `docs/muri-integration.md`.

## Production database

- **Prod = the `maglev` Railway DB** (`maglev.proxy.rlwy.net`). Schemas:
  `public` + `ponder_sync` + `ponder_v1`, with **`INDEXER_SCHEMA=ponder_v1`**.
- `apps/web/.env.local` MUST point at maglev with `INDEXER_SCHEMA=ponder_v1`.
  (Verified current: it does.)
- **Dead stack — do not trust:** an OLD `switchback` Railway DB had
  `ponder_v2`/`ponder_v3` schemas and `lazy_*` public tables. That is the
  pre-rebuild stack. maglev has **no** `lazy_*` tables and no v2/v3
  schemas. If your local env points anywhere but maglev, you will
  reconstruct the architecture wrong — this exact mistake cost a prior
  session hours.
- `ponder_v2`/`ponder_v3` would only ever be empty Ponder safe-redeploy
  namespaces if they existed; they don't exist on maglev. The live
  Ponder data is `ponder_v1`.

## STALE TRAP: untracked `ponder/` directory

There may be a leftover **untracked** `ponder/` directory in the working
tree (pre-rename: it holds only `generated/`, `node_modules/`,
`ponder-env.d.ts`). It is **NOT tracked on `main`** — `git ls-files
ponder/` is empty; `git status` shows it untracked. It misled a prior
session into believing Ponder wasn't on `main`. The real indexer is
`apps/indexer/`. `/ponder/` is now gitignored so it can't be
accidentally staged; delete the directory if you see it.

## Worker RPC

`apps/worker/src/rpc.ts` + `apps/worker/src/throttle.ts`:

- Multi-provider viem `fallback`, free public RPCs first:
  publicnode → tenderly → llamarpc → drpc → **Alchemy (last-resort backstop)**.
  publicnode now 403s *archive* `eth_getLogs` ("Archive requests require a
  personal token"), so Tenderly's public gateway sits right behind it to serve
  the worker's historical log scans for free before anything reaches paid
  Alchemy. `ankr` was dropped — `rpc.ankr.com/eth` is now fully key-gated
  (even `eth_call` returns -32000 without a key).
- A single **global throttle** (`throttleRpc()`) paces ALL tasks at
  ~2 req/s (`RPC_DELAY_MS=500`). One global limiter because drpc's free
  tier rate-limits at the account level.
- `eth_getLogs` ranges are chunked (worker bounds scan windows per task).
- **Quirk:** the drpc URL is currently stored under the env var
  `ALCHEMY_MAINNET_URL` (legacy naming — see the comment in `rpc.ts`).
  A real Alchemy key goes in `ALCHEMY_API_KEY` and is the paid backstop;
  it's also used for the trace-only client (trace_filter isn't served by
  the free public RPCs).

## Migrations

- `db/migrations/*.sql`, applied by `db/migrate.mjs` via `pnpm db:migrate`.
- Tracked in `public._migrations` (one row per applied filename). The
  runner globs `*.sql`, sorts, and applies any not already recorded — so
  a gap gets filled on the next run regardless of numeric order.
- **FLAGGED prod drift (verify before relying on it):** as of 2026-05-21,
  maglev `_migrations` records `001`–`015` and `017`, but **`016`
  (`016_log_index_bigint.sql`) is missing** — `017` was applied while
  `016` was skipped. `016` only widens two columns INTEGER→BIGINT
  (`artist_tokens.mint_log_index`, `token_transfers.log_index`) to stop a
  scan-mint-clones overflow crash. A future `pnpm db:migrate` will apply
  `016` after `017`; the column widening is order-independent, so this is
  low-risk, but **prod migration tracking is genuinely out of sync** —
  run `db:migrate` (with the maglev `DATABASE_URL`) to reconcile when
  you're ready. (Don't do it as a side effect of unrelated work.)

## Deploy topology

- **web → Netlify** (build config in `netlify.toml`, built from repo root
  so pnpm resolves the `@pin/*` workspace packages). Production deploys
  from `main`; the site is pnd.ripe.wtf.
- **worker + indexer + Postgres → Railway** (each app has a `railway.json`).
- NOTE / uncertain: `README.md` claims "No Netlify... one Railway
  project," but `netlify.toml`, `apps/web/.netlify/`, and `DEPLOYMENT.md`
  all show the web app on Netlify. The Netlify config is the live one;
  the all-Railway README line is aspirational/stale. `apps/web/railway.json`
  appears vestigial from the original plan. Treat netlify.toml as
  authoritative for where web actually deploys.

## Don't revive the pre-rebuild branches

These local/remote branches predate the rebuild and target the deleted
`ponder/` path or the removed web-side `lazy_*` scanning model. They will
never cleanly merge into `main`; don't revive or build on them:
`mint-into-ponder`, `srv2-into-ponder`, `tl-into-ponder`,
`mint-protocol-platform`, `ponder-srv2-tl-*`, `ponder-tl-srv2-*`,
`rpc-public-fallback`. (`tl-into-ponder` and `rpc-public-fallback` have
WIP stashes attached — leave those alone.)

## PND Collection System (native protocol)

PND's own onchain collection protocol (artist-owned contracts, honest
pricing with no protocol fee, per-token Mint Marks, Release Graph, Token
Path). This is distinct from the external platforms above
(Foundation/Manifold/Mint/etc.) that PND *indexes* for catalogs, the
collection system is a protocol PND *ships*. A single OZ ERC721 core with
four swappable slots (minter, price, renderer, hooks) and per-token id
modes; Editions is now one preset of this general core, not a separate
contract. Lives in `contracts/src/collection/` (`src/editions/` was
removed). **Start at `docs/pnd-collection-system.md` and
`docs/pnd-collection-contracts-plan.md`**, with `docs/injection-convention.md`
for the onchain-render data contract.

## See also

- `docs/pnd-editions-README.md` — PND Editions: overview, file map, dev/test/
  deploy, verification status (entry point; links the design plan, interface
  spec, integration runbook, and e2e harness).
- `ARCHITECTURE.md` — the accurate, current deep-dive (two-program model,
  known_artists, RPC strategy). Trust this one.
- `apps/indexer/ponder.config.ts` — the indexed/discovery-only contract list.
- `apps/worker/src/scheduler.ts` + `tasks/` — the scan heartbeat.
- `apps/web/src/lib/reads.ts` + `onchain.ts` — the web data-fetch contract.
- `CONTINUATION.md`, `CUTOVER.md`, `PLAN.md` — historical; see their banners.
