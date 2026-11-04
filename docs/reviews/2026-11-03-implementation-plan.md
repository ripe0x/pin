# Implementation plan: all remaining open work (2026-11-03)

This plan follows `2026-11-03-system-review.md`. It covers every open issue after
the triage (#261, #262, #264, #265, #267, #268, #269, #270, #274, #284, #289,
#295–#299, #351, #364, #365), the review findings that have no public issue, and
the open PR backlog.

How to read it:
- **Tracks** group related work.
- **PR numbers** in this plan (A1, B2, …) are planning labels, not GitHub PR numbers.
- Within a track, PRs are ordered by dependency.
- **"Ops (maintainer)"** marks steps that need production credentials: Railway,
  Netlify, maglev, R2, deploy keys. The code side of those steps is still in scope.

## Working agreement

- **Branches and PRs.** One branch per PR, named `claude/<topic>`, opened against
  `main` (or stacked when noted). Each PR closes or references its issues.
- **Checks before every PR goes up.** Run the same steps CI runs (install,
  codegen, lint, typecheck, unit tests, build), plus `forge test` when contracts
  change. Run an anvil e2e test when a mint, bid or studio flow changes. Take a
  Playwright screenshot when the UI changes.
- **Watching PRs.** Each PR is subscribed after opening, and CI failures and
  review comments are fixed on that PR.
- **Security fixes** ship with neutral PR descriptions until they are deployed.

## Track A: safety and integrity (first; no dependencies)

### A1: Web hardening
**Scope**
- **Artwork-serving routes** (`/api/escape/[tokenId]`,
  `/collections/[address]/[tokenId]/live`): check the address against the indexed
  collection set and derive the renderer from the collection. Redirect only to
  allowlisted gateways, and add `connect-src 'none'` to sandboxed documents.
- **`GET /api/revalidate`:** remove it; keep the bearer-secret POST.
- **Allowlist publish:** gate on a known collection and an owner signature, and
  cap stored rows per collection.
- **`/api/meta/[contract]/[tokenId]`:** validate input, and only persist rows for
  tokens PND already knows.
- **Rate limiting:** key on `x-nf-client-connection-ip`, and back the limiter with
  a shared store (a Postgres table with a TTL). Apply it to every refresh and
  cache-bust route.
- **`/api/rpc`:** origin check, a gas cap on `eth_call`/`eth_estimateGas`, an
  overall deadline, no `eth_getLogs` on paid upstreams, and batch-shaped errors.
- **Security headers:** `frame-ancestors 'none'`, Referrer-Policy,
  Permissions-Policy, `poweredByHeader: false`, and a CSP in report-only mode.
- **Smaller items:**
  - add `import "server-only"` to the Alchemy modules
  - add a root `error.tsx` and `global-error.tsx`
  - remove the Foundry chain from the production wagmi config
  - drop the `WORKER_SECRET` fallback

**Tests:** a route-level unit test for each changed handler, covering auth
rejection, validation and rate-limit paths.

### A2: Dependency security
- **next** 15.5.28 or later.
- **sharp** 0.35.5 or later.
- **Root `pnpm.overrides`:** refresh or remove axios, hono, @hono/node-server,
  fast-uri and brace-expansion.
- **Afterwards:** re-run `pnpm audit --prod`, and record any advisories that
  can't be fixed yet (Ponder's transitive ones) in the PR.

### A3: Data integrity I (#295 part 1, the #297 bug)
**Cursor fixes**
- `scanners/manifold.ts` (`getLogs` and `trace_filter`), `scan-fnd-shared.ts`, and
  the SuperRare/TL active-auction trackers.
- On an RPC error, the cursor stops at the last good chunk. A range that keeps
  failing is split in half, down to a floor, and then reported.

**`known_artists`**
- A migration adds a `pnd_rebuild_known_artists(schema text)` SQL function.
- The worker calls it at startup whenever the view's schema doesn't match
  `INDEXER_SCHEMA`.
- The cutover runbook calls it explicitly.

**Other fixes**
- **Schema defaults:** set `ponder_v4` everywhere (web, the check script, the
  worker and its test, and the CI smoke-test stub). The worker gets the same
  freshness guard web has. This supersedes PR #343.
- **Foundation shared rows:** dedupe on `(contract, token_id)` in `reads.ts` and
  `onchain-discovery.ts`.
- **RefreshButton:** match the `{ ok, enqueued }` response from
  `/api/refresh-artist`.

**Tests:** scanner tests against an RPC client that injects errors, proving that
the cursor never passes a failed range.

### A4: Auction-house mitigations in the UI (#289, plus a privately reported item)
- **V1 houses:** stop offering new bids on V1-house listings, show a migrate
  prompt to their owners, and add a worker check that flags any bid landing on a
  V1 listing.
- **V2 houses:** guard ERC-1155 lots (seller warning and listing guard), and flag
  deferred deliveries where the bidder is a contract.
- **Docs:** update `docs/auction-house-migration-plan.md`.
- **Closes #289** once deployed.

### A5: CI repair (part of #351 item 2)
- **e2e setup:** `globalSetup.ts` must stop deploying the deleted `RenderAssets`.
- **Mutation test:** update the anchor that no longer matches `FixedPriceSale`.
- **Separate job:** move `check:abi` and the mainnet fork tests into their own job.
- **Pin versions:** `foundry-toolchain`, and the CI Node version so it matches
  `.node-version`.
- **Playwright smoke test:** run it against Netlify deploy previews, covering the
  landing, an artist page, a token page, a collection page and the mint page.

### A6: Small fixes and backlog PRs
- **Mint gate:** a clear message for non-Surface addresses (promised on #253).
- **`chainId` on writes:** pass it on every `writeContract`, and simulate before
  any value-bearing write.
- **Backlog PRs:** rebase and land #124 with #125 folded in, and #324.

## Track B: Surface v2 ship (starts after A3 lands; A3 fixes the schema defaults and `known_artists`)

### B1: Indexer replay set (stacked on #358)
These all go into the single `ponder_v5` replay, so the schema is bumped once.

**#358 fixes**
- **Renounce bug:** handle a zero `newOwner` in `SurfaceV2:OwnershipTransferred`,
  so renounced collections stay visible.
- **Contract-owned collections:** document that Safe- or contract-owned
  collections start unconfirmed.

**New handlers**
- **Surface v1 and v2 child `Transfer`:** the true current owner (#269, #296).
- **v1 `CreatorListed`:** for the attribution roster (#261).
- **FoundationNFT and SuperRareNFT `Transfer`:** current owner for the shared
  contracts (#296, Ponder side).

**Cutover tooling**
- Port the `indexer_live` alias and the parity-gated switch script from #300.
- The drift check gets a `protocol_version` filter, stops swallowing insert
  errors, and runs in detect-and-alert mode.

**Runbook (`docs/ponder-schema-cutover.md`)**
- Correct the outdated statements: the factories are unpaused, and v5 is not
  expected to match v4 exactly.
- Add steps: flip the worker's `INDEXER_SCHEMA`, run the Form of Solitude
  spot-checks, and rebuild `known_artists`.

**Ponder upgrade:** evaluate Ponder 0.17.x here (it includes the factory-child
restart fix). The replay is fresh anyway.

### B2: Deploy record
- Rebase #357.
- Fix the stale `_note` in `deployments.mainnet.json`.
- Run `pnpm generate:docs`.
- Merges immediately after B1.

### B3: Web v2 rebind
Rebase #360 and fix:
- Route only the primitive-v2 implementation down the v2 path.
- A closed sale with a future start must show Closed.
- Don't hide the mint button when the sale read fails.
- Keep one `NO_REFERRAL_COLLECTIONS` source.
- Fix the `RendererPermanenceNote` v2 copy.

### B4: Cutover (ops, maintainer)
1. Deploy `indexer-v4` from the pre-B1 tag.
2. Create the `indexer-v5` service and replay.
3. Run the parity script.
4. Merge B3.
5. Flip `INDEXER_SCHEMA=ponder_v5` on Netlify production and the Railway worker.
6. Confirm on `/api/health/indexer`.

Code side (in scope): a follow-up PR that sets the defaults to `ponder_v5` and
updates AGENTS.md.

### B5: Studio rebind (#364)
**Create and manage**
- Create through `Launcher.launch`.
- The v2 settings panel: renderer, supply cap, royalty, name, minter slot, and
  renounce (type-to-confirm, §8 precondition).
- The v2 sale panel: price, window, `maxMints`, `walletCap`, `close()`.
- The v2 mint gate through `AllowlistGate`.
- The airdrop flow, using EIP-5792 batching where the wallet supports it.

**Test:** an anvil e2e for the full lifecycle.

### B6: Template rebind (#264 and #274)
- **Mint path:** route through the sale. v2 uses `mintWithReferral`; v1 uses
  `FixedPriceMinter.mint`.
- **Render lib:** sweep it and re-point references at
  `docs/injection-convention.md`.
- **ABIs and docs:** refresh the vendored ABIs and update the template README.
- **Sync:** verify the sync workflow to `ripe0x/sovereign-artist-site`.

## Track C: pipeline and data model II

### C1: Data integrity II (#295 part 2, the rest of the #351 phase-0 ops)
**Scanner correctness**
- A finality helper (stop at finalized, or head minus 12, with a replay overlap)
  used by every scanner.
- Backfill each newly discovered token's transfers from its mint block.
- Validate log indexes.
- Cursor writes use `GREATEST`.
- A transient failure no longer records a contract as not-ERC721/1155 forever.

**Health and onboarding**
- **Per-task health:** fail when any task errors N runs in a row or is stuck
  running.
- **Onboarding:** order and back off in `seed-known-artists`.

**Retention and performance**
- **Retention:** scheduled pruning for `cache_entries` and `worker_iterations`.
- **Indexes:** remove `lower()` on columns that are already lowercase, and add the
  missing indexes.
- **Timeouts:** a worker Postgres statement timeout.
- **RPC cost:** batch `scan-token-transfers` into multi-address `getLogs` calls,
  and add a negative cache to `scan-pnd-auction-tokens`.

### C2: Ownership (#296, worker side)
- Mirror the B1 Transfer data into `token_owners`.
- An ERC-1155 balance table and scanner for known artists' 1155 contracts.
- Remove the silent `LIMIT 200`.
- Collector reads via `getCollectorTokens`, with pagination.

### C3: Durable refresh and availability (#297)
- A `refresh_jobs` table (ported from #300) replaces the in-memory queue.
- A per-artist cooldown.
- A normalized sale-state view, with galleries ranked by availability (live
  auction, buy-now, then the rest).

### C4: Media derivatives (#298, part of #351 item 4)
**Depends on:** R2 and the `MEDIA_OBJECT_*` env vars (ops, maintainer).

- **Gallery:** `ArtistGallery` moves onto derivatives with a grid layout, lazy
  images, video posters, and an explicit failure tile.
- **One component:** a single `Artwork` component replaces the TokenMedia,
  TokenStage and OnchainArt duplicates.

## Track D: product surfaces (after B3; these are SELECT-only once B1 is replayed)

- **D1, discovery (#262):** a Collections link in Navbar, MobileMenu and Footer,
  and a paginated `/collections` covering v1 and v2.
- **D2, generic gallery (#269):** a gallery for every collection, with an owned-by
  filter from the v5 owner data.
- **D3, secondary market (#268):**
  - Marketplace deep links, and "Minted for X ETH" from `collection_sales`.
  - Phase 2b: worker-side Seaport `OrderFulfilled` indexing for PND collections
    only, then "last sale" on token pages.
- **D4, attribution (#261):** the v2 roster from `catalog_contracts`, the v1
  roster from `CreatorListed` intersected with Catalog claims, and the creators UI
  hidden on v2.
- **D5, preservation grade (#265):** v1 lock facts, v2 renounced, supply and
  storage facts, and the MURI anchor where it applies. Also pulls forward the
  #284 WS6 storage-honesty copy.
- **D6, launch consolidation (#270), three PRs:**
  1. layout extraction
  2. descriptor-driven layout kinds, with the referral exemption in descriptors
  3. shared mint components between `/collections` and `/mint`
- **D7, profiles (#299):** `/artist/[address]` gains Available, Created, Collected
  and Catalog tabs; `/profile/[address]` redirects to it (default; see decisions).
- **D8, stability epic (#351), rolling:**
  - Result-typed reads, page by page: landing, artist, token, collection.
  - Remove `.catch(() => [])` from the read layer.
  - Route pruning and redirects.
  - A `chain_logs` raw store in the worker, then retire the Alchemy paths and add
    cost telemetry.

## Track E: contracts and design (audit-gated where noted)

- **E1, auction house V2.1** (the privately reported item):
  - A new implementation and factory that fix ERC-1155 settlement.
  - The proof-of-concept tests become regression tests.
  - A deploy script, plus a `useDeployHouse` switch behind an address flag.
  - **Audit, then deploy (maintainer).**
- **E2, thumbnails design note (#365):**
  - Check MURI's `registerContract` against v2 first.
  - Write the doc, then file the build issues.
- **E3, `CommitRevealSale` (#267):**
  - A design doc first, settling the seed-at-reveal approach.
  - Then the contract, invariant and fuzz tests, mutation tests, and a deploy
    script.
  - **Needs:** a named drop. **Audit, then deploy (maintainer).**
- **E4, contract docs:**
  - The `FixedPriceSale` receiver-check behaviour.
  - Stranded-referral cases, including v1 `FixedPriceMinter` with
    referrer = minter.
  - The seller pause-and-unwind trade-off.

## Execution order

1. **A1, A3** in parallel, then **A2, A5, A4, A6**
2. **B1 → B2 → B3**, then the B4 cutover (ops)
3. **B5, B6**
4. **C1 → C2 → C3**
5. **D1, D2, D4, D3** (deep links and "minted for"), **D5**
6. **D6** (three PRs)
7. **C4** once R2 exists
8. **D7**
9. **D8**, rolling
10. **E1 → E2 → E3** (E3 waits on a named drop); **D3** phase 2b alongside

#284 stays open as the strategy issue and is checked off as tracks land.

## Open PR backlog
- **Close** (pending maintainer OK): #293, #233, #210, #171, #108, #107, #106,
  #290 (keep the branch), #300 (after the B1/C2/C3 ports), and #343 (superseded
  by A3).
- **Merge now:** #363, #347 (then deploy `indexer-v4`).
- **Product decision:** #152.

## What needs the maintainer
1. **Merging.** Merge rights stay with the maintainer unless explicitly delegated
   (for example, "merge on green" for low-risk PRs).
2. **Existing PR branches.** Whether B1–B3 push to the existing #358, #357 and #360
   branches, or stack new PRs on them.
3. **Ops:**
   - Railway deploys and the `indexer-v5` service
   - Netlify and Railway env flips
   - checking `known_artists` on maglev and reconciling migration 016 (in a
     maintenance window)
   - provisioning R2
   - contract deploys and audits
4. **Product decisions:**
   - **#299:** route shape (tabs on `/artist` is the default)
   - **#268:** secondary data source (worker Seaport indexing is the default)
   - **#267:** the named drop
   - **#152:** whether to ship it

## Status (2026-11-04)

Every planned item now has an open PR, except the ones waiting on a
maintainer decision or on ops. Nothing is merged yet. Stacked PRs name
their base.

| Plan item | PR | Base |
|---|---|---|
| A1 Web hardening | #369 | main |
| A2 Dependency security | #366 | main |
| A3 Data integrity I (#295, #297 bug) | #368 | main |
| A4 Auction mitigations (#289) | #372 | main |
| A4 Template parity | #378 | #376 |
| A5 CI repair | #367 | main |
| A6 Small fixes (includes #124, #125, #324) | #373 | main |
| B1 `ponder_v5` replay set (adds `launch_owner`, `token_ownership.last_block` index) | #370 | #358 |
| B2 Deploy record fixes | #371 | #357 |
| B3 Web v2 rebind fixes | #374 | #360 |
| B5 Studio v2 rebind (#364) | #382 | #374 |
| B6 Template rebind (#264, #274) | #376 | main |
| C1 Data integrity II (#295) | #377 | #368 |
| C2 Ownership, worker side (#296) | #380 | #377 |
| C3 Refresh jobs and availability (#297) | #381 | #377 |
| D1 Discovery (#262) | #385 | #374 |
| D3 Secondary links, phases 1 and 2a (#268) | #386 | #374 |
| D4 Attribution (#261) | #388 | #374 |
| D5 Preservation grade (#265) | #387 | #374 |
| D7 Profiles (#299) | #384 | #380 |
| D8 Route pruning (#351) | #383 | main |
| E2 Thumbnails design note (#365) | #375 | main |
| Docs: v2 renderers | #379 | main |
| E1 Auction house V2.1 | local branch, held until #372 is deployed | — |

**Waiting on a decision or on ops:**
- #267 CommitRevealSale: needs a named drop.
- #365 build issues: need the two decisions in #375.
- C4 gallery derivatives (#298): needs R2 and `MEDIA_OBJECT_*` provisioned.
- D2 gallery owned-by filter (#269) and D6 launch consolidation (#270): wait for the #358 → #360 → #374 stack to land. Doing them now would conflict with five open PRs.
- D3 phase 2b (#268): secondary-sale indexing, after the `ponder_v5` cutover.
- D8, the remaining #351 increments (Result-typed reads, one Artwork component, `chain_logs`): after the read-layer PRs (#368, #377, #381, #384) merge.

**Known merge conflicts:**
- #369 and #383 (`/api/activity`): keep the deletion.
- #369 and #381 (the two refresh routes): keep #369's limiter.
- #381 and #384 (`artist/[address]/page.tsx`): parse both `sort` and `tab`.
- #382 and #367 (CI e2e job name): move the Postgres service to `web-e2e`.
- #379 and #371 (generated docs): rerun `pnpm generate:docs`.
- #385–#388: textual conflicts only, in the collection page, `collection-onchain.ts` and `collection.ts`.
