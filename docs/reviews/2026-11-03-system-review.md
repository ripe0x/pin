# PND system review — 2026-11-03

A full review of the repo as of `main` at `6c1da1e`: every open issue (33), every
open PR (19), the contracts, the worker/indexer pipeline, the web app, and CI.
The question was what to build next, whether the open issues still hold, and
whether the site and system stand up to scrutiny.

> **Disclosure note.** This repo is public. Security findings that are not yet
> fixed appear below only as one-line work items, with no exploit detail. The
> full write-ups, including proof-of-concept tests, were handed to the
> maintainer privately. Once a fix ships, its detail can be added here.

## Bottom line

- **Contracts hold up best.** 688 forge tests pass, and CI also runs invariant,
  symbolic (halmos), slither and audit-regression suites. A fresh review of
  Surface v2 (Surface, FixedPriceSale, AllowlistGate, Launcher, CloneFactory)
  found no way to steal or lock funds. The auction houses have one new Medium
  and confirm one old one (see [Auctions](#auctions)).
- **The data pipeline is the weakest layer.** Several scanners turn an RPC error
  into "this range had no events" and move their cursor past it, which leaves
  holes that are never filled. These are silent, they compound over time, and
  they are cheap to fix. This is the most important engineering work.
- **The web app is resilient to a cold database** after the #339–#346 guard work.
  It still has a handful of unauthenticated or unvalidated routes that cost money
  or let someone host content on pnd.fyi. Fixing them is one batch of work.
- **Surface v2 is live on mainnet, and PND can't see it yet.** Form of Solitude
  mints through a bespoke page. The indexer (#358), the deploy record (#357) and
  the web rebind (#360) are open, and they have to merge in a specific order.
  #358 has one bug to fix first.
- **The backlog needs pruning more than adding to.** Of 33 open issues, about 15
  are done, superseded by Surface v2, or are umbrellas replaced by #351. Of 19
  open PRs, about 9 should be closed.
- **CI is green on `main`, but the weekly scheduled run has failed seven weeks
  running.** Because of that, the mainnet fork tests and the ABI drift check have
  not run since 2026-09-14.

## Scorecard

| Area | State | Biggest gap |
|---|---|---|
| Contracts (Surface v2, Catalog) | Strong | Nothing blocking; low and info findings only |
| Contracts (auction houses) | Good for ERC721; gaps for V1 houses and V2 ERC-1155 lots | Liveness and griefing ([Auctions](#auctions)) |
| Worker scanners | Fragile | Errors advance cursors; no finality boundary; health check passes while tasks fail |
| Indexer (Ponder) | Good | Surface v2 not indexed on `main`; drift repair weaker than it looks |
| Web reads / resilience | Good | Duplicate Foundation rows; refresh button crash |
| Web security posture | Needs a batch | Unauthenticated routes, no security headers, per-instance rate limits |
| Dependencies | Behind | `pnpm audit --prod` reports a critical advisory in next 15.5.24; several root `pnpm.overrides` pin below fixes |
| Tests / CI | Contracts excellent; everything else thin | No tests for scanners, indexer handlers, API routes, or the mint/bid value math; e2e is not gating |

## Priority roadmap

### P0 — this week (security, silent data loss, the v2 ship)

**Security and dependencies**

1. **Web hardening batch** (S–M; details private).
   - Validate the `renderer`/collection of every artwork-serving route against
     the indexed collection set.
   - Remove the unauthenticated `GET /api/revalidate`; keep the bearer-secret POST.
   - Gate the allowlist and metadata write routes on known collections and tokens.
   - Cap gas, check origin, and set an overall deadline on `/api/rpc`.
   - Key rate limits on Netlify's client IP header and back them with a shared
     store instead of per-instance memory.
   - Add security headers (`frame-ancestors`, Referrer-Policy,
     `poweredByHeader: false`, and a CSP in report-only mode first).
2. **Dependency bumps** (S). Bump `next` to 15.5.28 or later (`^15.5.21` already
   allows it) and `sharp` to 0.35.5 or later. Refresh or remove the stale root
   `pnpm.overrides` for axios, hono, @hono/node-server, fast-uri and
   brace-expansion. Re-run `pnpm audit --prod` afterwards.
3. **Auction-house mitigations in the UI** (S; contract detail private).
   - Stop offering new bids on V1-house listings, and prompt those owners to
     migrate. This reverses the advice in `docs/auction-house-migration-plan.md`,
     now that V2 exists.
   - Add a V2 guard for ERC-1155 lots. A contract fix needs a new V2
     implementation and factory (P1).

**Data integrity** (each S; together about one to two days)

4. **Scanner errors must not advance cursors.** Affected:
   `apps/worker/src/scanners/manifold.ts` (the `.catch(() => [])` on `getLogs`
   and the `trace_filter` catch), `scan-fnd-shared.ts`,
   `scan-srv2-active-auctions.ts` and `scan-tl-active-auctions.ts` (failed
   multicall entries are skipped). The fix: on error, stop and save the cursor
   only up to the last good chunk, and split a range that keeps failing.
5. **Rebuild `known_artists` from `INDEXER_SCHEMA`.** Migration
   `011_known_artists_view.sql` builds the view against whichever `ponder*`
   schema was newest when it ran, and nothing rebuilds it. That view is the
   worker's spend ceiling: artists who only appear in newer schemas are never
   scanned. Check prod first with `SELECT pg_get_viewdef('known_artists')`, then
   make the rebuild part of every schema cutover.
6. **Schema defaults.** Web (`apps/web/src/lib/indexer-schema.ts`,
   `scripts/check-indexer-schema.mjs`) defaults to `ponder_v2` and the worker
   (`apps/worker/src/indexer-schema.ts`) to `ponder_v3`, but prod is `ponder_v4`.
   Production is right only because of the Netlify override; deploy previews and
   dev read a rollback schema. Retarget #343 to `ponder_v4` across all three, and
   give the worker the same freshness check web has.
7. **Foundation shared tokens are counted twice.** `apps/web/src/lib/reads.ts`
   and `onchain-discovery.ts` combine worker rows and Ponder's `fnd_artist_tokens`
   with `UNION ALL`. Dedupe on `(contract, token_id)`.
8. **Refresh button crash.** `components/catalog/RefreshButton.tsx` reads
   `json.added.manifold`, but `/api/refresh-artist` now returns `{ ok, enqueued }`,
   so the button throws on render after every successful refresh.

**Surface v2 ship** (see the [sequence](#surface-v2-ship-sequence) below)

9. Fix #358's renounce bug: `ownerConfirmed` becomes false on
   `renounceOwnership()`, and #360's filter then hides sealed collections. Update
   the #358 runbook. Then ship in order.

**CI**

10. **Repair the weekly run.**
    - `apps/web/tests/e2e/fixtures/globalSetup.ts` still deploys
      `RenderAssets.sol`, which #353 deleted.
    - The v2 mutation anchor (`sale_reorder_03_05`) no longer matches the code
      after #355.
    - Move `check:abi` and the mainnet fork tests into their own job, so a
      browser-test failure can't hide them again.
    - Pin the `foundry-toolchain` version.

### P1 — next two to four weeks

- **Studio v2 rebind** (M–L; successor to #260, absorbs #266's airdrop UI).
  `DeployStep`, `CollectionSettingsPanel` and the sale settings still target the
  superseded `SurfaceFactoryV2` ABI. With the factories unpaused, artists can't
  launch or manage v2 collections in PND's own studio. Scope:
  - `Launcher.launch` and renounce
  - `setName` and the single-slot `setMinter`
  - closing the sale, the gate, and the wallet cap
  - an airdrop flow (`setMinter(owner)` → `mintTo` → `setMinter(sale)`) that
    warns the sale pauses while the owner holds the slot
- **Artist-site template rebind** (M; #264 and #274 together). The template's
  mint path calls functions no deployed contract has, and it auto-syncs to the
  public template repo. Rebind it to `FixedPriceSale.mintWithReferral` (and v1
  `mint`), and remove the stale GenerativeRenderer references.
- **Auction house V2.1** (M, audit-gated). Make the ERC-1155 settlement fix in a
  new implementation and factory. Point `useDeployHouse` at it, and offer
  migration for houses that list ERC-1155 lots.
- **Pipeline hardening, round two.**
  - **Finality:** one helper that caps every scanner at the finalized block, or
    head minus 12, with a small replay overlap.
  - **Transfer history:** backfill each newly discovered token's transfers from
    its mint block; today `scan-token-transfers.ts` drops logs for tokens not
    yet known.
  - **Drift check:** stop swallowing insert errors, add the
    `protocol_version = 1` filter so v2 collections aren't pushed into v1 watch
    lists, and make it detect-and-alert rather than repair.
  - **Health:** report per task (any task failing N runs in a row, or stuck
    running) instead of passing when any task finished in the last 30 minutes.
  - **Refresh endpoint:** a per-artist cooldown on `/api/refresh-artist`.
  - **Onboarding:** order and back off in `seed-known-artists`, so five failing
    artists can't block everyone else.
  - **Cache pruning:** schedule `pgCacheCleanup`, since `cache_entries` is never
    pruned.
  - **RPC cost:** batch `scan-token-transfers` into one multi-address `getLogs`
    per window.
  - **Indexes:** drop `lower()` on columns that are already lowercase, so
    indexes are used.
- **Ownership index** (M; #296). Track transfers for the shared Foundation and
  SuperRare contracts, add an ERC-1155 balance model, and remove the silent
  `LIMIT 200`. Port the model from PR #300 rather than writing it again.
- **Media derivatives actually run** (S, then S–M; #298). `derive-token-media`
  produces nothing until the `MEDIA_OBJECT_*` (R2) env vars are provisioned.
  After that, move `ArtistGallery` onto derivatives with lazy media and an
  explicit failure state.
- **Tests where the money and the data are.**
  - The SuperRare `msg.value` and 105% minimum-bid math (`AuctionPanel.tsx`,
    `lib/auctions.ts`).
  - The mint `sendValue` amount (`MintCollectionCTA.tsx`).
  - The allowlist merkle builder and proof route.
  - One test per scanner, with an RPC that injects errors.
  - Indexer handler tests for `Collections` and `SovereignV2`.
  - A Playwright smoke test in CI.

### P2 — after v2 is fully shipped

- **Already SELECT-only:** #269 generic token gallery (the owned-by filter needs
  the Transfer handler from the ponder_v5 replay), #262 nav link and pagination,
  #268 secondary deep links and "minted for X ETH", #261 v2 roster from
  `catalog_contracts`.
- **#270 un-special-case launches.** Three launches now use three different web
  shapes, and `collections/[address]/page.tsx` is about 1,000 lines.
- **#299 unified profiles**, after #296.
- **#351 as an incremental epic.** Its diagnosis is accurate, but a parallel
  `apps/site` would be the third big-bang plan in ten weeks and would compete
  with the v2 ship. Do its phase-0/1 ops work and adopt Result-typed reads, one
  Artwork component and one revalidate path route by route inside `apps/web`.
  Rewrite a subtree only if it can't be unified in place.
- **#267 as a `CommitRevealSale` primitive** (L, audit-gated). The design maps
  cleanly onto v2's single minter slot; tie it to a named high-value drop.
- **#265 preservation grade**, reworded for v2: permanence means renounced
  ownership plus the renderer's own image.
- **One "HTML thumbnails under v2" design note** to replace #138, #271 and #272.
  Confirm first whether MURI's `registerContract` can register v2 collections,
  which have no `isAdmin`.

## Surface v2 ship sequence

Context: Ponder's build id covers contracts, schema and handler code, but not RPC
settings, and an existing schema refuses a different build id. So once #358 or
#357 is on `main`, `indexer-v4` can no longer be redeployed from `main`.

1. Merge #363 (freshness logging) and #347 (indexer RPC fallback). Run
   `railway up --service indexer-v4`, and tag that commit as the pinned rollback
   source.
2. Fix #358:
   - `apps/indexer/src/Collections.ts`, `SurfaceV2:OwnershipTransferred`: on a
     zero `newOwner`, keep the previous `ownerConfirmed` or set it true.
   - Document that collections owned by a Safe or other contract start
     unconfirmed.
   - **Before this replay, also add** a `Transfer` handler for v1 and v2 Surface
     clones (true current owner, which unblocks #269) and v1 `CreatorListed`
     (#261). That avoids a `ponder_v6` bump later.
   - Update `docs/ponder-schema-cutover.md`: the factories are no longer paused;
     `ponder_v5` should not match `ponder_v4` exactly; add the worker's
     `INDEXER_SCHEMA` flip on Railway; add a Form of Solitude spot-check (the
     collection row, the sale in `minters`, and a `collection_sales` count equal
     to the on-chain `Sold` count).
3. Merge #358, then #357 straight after. Never merge #357 first: it would bind the
   new factory to the old ABI.
4. Stand up `indexer-v5` writing `ponder_v5` and replay from genesis. Run the
   parity, `factory_addresses` watch-set and Form of Solitude checks. Watch
   drpc's 10k-block range limit during the replay.
5. Rebase and merge #360 *before* the flip. Its column-existence guard keeps it
   safe on `ponder_v4`.
6. Flip `INDEXER_SCHEMA=ponder_v5` in Netlify production **and** in the Railway
   worker, redeploy, and confirm on `/api/health/indexer`. Land the retargeted
   #343 with all three defaults set to `ponder_v5`. Rebuild `known_artists`
   (P0 item 5).
7. Keep `indexer-v4`/`ponder_v4` as the rollback pair.

## Open issues: verdicts

| # | Title (short) | Verdict | Action |
|---|---|---|---|
| 351 | Rebuild `apps/site` | Diagnosis right, plan too big | Convert to an incremental epic (P2) |
| 302 | Portable venue program | Built for Surface v1 | Close; re-scope the kit against v2 after launch |
| 301 | Whole-site experience | Umbrella; its "done in #300" items aren't on `main` | Close, superseded by #351; the revalidate item is in P0 |
| 299 | Unified profiles | Valid, not started | P2, after #296 |
| 298 | Media delivery | Partly done (`@pnd/media`, `derive-token-media`) but not running | P1: provision R2, move the gallery onto derivatives |
| 297 | Availability and refresh | Valid; live crash | Fix RefreshButton (P0); ranking later |
| 296 | Ownership index | Valid, nothing done | P1 |
| 295 | Indexer integrity | Valid; live bugs confirmed | P0 items 4–6, then P1 |
| 294 | Profile reliability umbrella | Umbrella | Close, superseded by #351 |
| 289 | `endAuction` lock | Fixed for V2 houses (#303); real and unpatchable on V1 | Keep open until the V1 UI mitigation ships, then close |
| 284 | Strategic direction | Still the north star | Edit its v1-era steps to say v2 |
| 275 | Gen art v1 tracker | Superseded by v2 | Close |
| 274 | Template mint embed | Valid; needs v2 wording | P1, with #264 |
| 273 | Generative wizard | Depends on deleted ScriptyRenderer | Close |
| 272 | Capture phase 2 | Its target (RenderAssets) was deleted | Close; fold into the thumbnails note |
| 271 | Capture phase 1 | Partly obsolete | Fold into the thumbnails note |
| 270 | Un-special-case launches | Valid, more pressing | P2, phased, after #360 |
| 269 | Generic token gallery | Valid, not built | P2 (owner filter needs the v5 Transfer handler) |
| 268 | Secondary surfacing | Valid, not built | P2 (deep links and mint price now) |
| 267 | CommitRevealMinter | Maps onto v2 as a sale primitive | Reword; P2, audit-gated |
| 266 | OwnerMinter | Contract unnecessary in v2 | Close; airdrop UI joins the studio v2 rebind |
| 265 | Preservation grade | Needs v2 wording | Reword; P2 |
| 264 | Template render lib stale | Live bug | P1, with #274 |
| 263 | Offchain assembly fallback | Relied on deleted getters | Close |
| 262 | Collections discovery | Partly done (homepage links only) | P2 |
| 261 | Attribution roster | v2 credit is Catalog-only | Reword; P2 (and the v5 handler) |
| 260 | Studio management panel | Done for v1 (#327); v2 needs new work | Close; open a "Studio v2 rebind" issue (P1) |
| 259 | RendererFactory | ScriptyRenderer deleted | Close |
| 258 | Mainnet RenderAssets + DefaultRenderer | Sources deleted in #353 | Close |
| 253 | Mint page (user question) | FND Drop contracts aren't Surface; failure expected | Reply and close |
| 234 | Surface launch #2 | Shipped (escape blue) | Close |
| 140 | Docs snapshot reconcile | Done | Close; rerun `pnpm generate:docs` after #357 |
| 138 | MURI thumbnails | Written pre-Surface | Fold into the thumbnails note |

## Open PRs: verdicts

| # | Verdict |
|---|---|
| 363 | Merge now |
| 360 | Rebase; merge after #358/#357 and before the schema flip |
| 358 | Fix the renounce bug, update the runbook, add the Transfer/CreatorListed handlers, then merge |
| 357 | Merge right after #358, never before; fix the stale `_note` |
| 347 | Merge now; deploy to `indexer-v4` before #358 lands |
| 343 | Retarget to `ponder_v4` across web, the check script and the worker |
| 324 | Merge |
| 300 | Close as superseded (65 commits ahead, 54 behind, migration-number collisions); port its `indexer_live` alias, parity-gated cutover, ownership model and finality helper as small PRs |
| 293 | Close; #305 landed the same change |
| 290 | Close; keep the branch as reference (its capture tooling may be worth salvaging) |
| 233 | Close; nothing reads `defaultRendererSet` |
| 210, 171 | Close; stale docs |
| 152 | Product decision; merges cleanly but idle for four months |
| 125, 124 | Merge (fold #125 into #124); `AuctionPanel` still POSTs to a 404 |
| 108, 107, 106 | Close; `src/editions` was removed |

## <a id="auctions"></a>Auctions

- **V1 houses (#289).** Confirmed. If a lot's transfer reverts after a bid exists
  (a paused collection, a blocklisted bidder, a transfer-policy change), the bid
  stays locked. There is no cancel, recovery or upgrade path. V1 clones can't be
  patched, so the mitigation is in the UI: stop new bids and migrate owners to V2.
- **V2 houses.** Escrow-and-wait settlement (#303) fixes the V1 lock for ERC721.
  A separate Medium affects ERC-1155 lots; it was reported privately and is
  tracked as P0 item 3 (UI guard) plus P1 (V2.1 implementation).
- **Low / info.** A seller who controls the token contract can void a sale by
  pausing transfers and waiting 30 days; this is inherent to the #289 fix, so
  document it and badge pausable collections. `FixedPriceSale`'s receiver check
  runs before the token exists, with the sale as the sender. Referrers that can't
  withdraw strand their share, including v1 `FixedPriceMinter` when the referrer
  is the minter itself.

## Needs prod access to confirm

This review had no database, Railway or Netlify access. Check these against the
real systems:

1. `SELECT pg_get_viewdef('known_artists')` on maglev: which schema it reads.
2. The mainnet bytecode of the Surface v2 contracts matches `main` at #355.
3. `SOVEREIGN_V2_FACTORY_*` is set on the live `indexer-v4`.
4. Migration `016` is still unapplied. When you reconcile it, run it in a
   maintenance window: INTEGER→BIGINT rewrites the table under an exclusive lock.
5. Whether Netlify's image CDN fronts `/_next/image`, which decides how exposed
   the Next advisory is.

## Method

The review was split into seven parallel tracks: program/strategy issues,
Surface/feature issues, the PR backlog, contracts, the worker and indexer, the
web app, and build/test/CI. The headline claims were then checked by hand
against the code:

- the RefreshButton crash
- the Manifold catch-and-advance
- the `known_artists` pinning
- the unvalidated artwork renderer route
- #358's renounce logic
- V2 `unwindStuckLot` behaviour
- the indexer event mismatch on `main`

Local CI passed in full (install, codegen, lint, typecheck, 336 unit tests,
build). Forge ran 688 tests: 688 passed, 1 failed, 5 skipped. The one failure is
a known forge-version address prediction, not a contract bug.
