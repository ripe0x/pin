# Ponder schema versioning: why it's a mess, and moving to the views pattern

> **Status: proposed.** Written 2026-10-06 after the production
> "Indexed data is stale (last update 8d ago)" incident. This records
> *why* the `ponder_v1/v2/v3/v4` scheme exists, what's actually wrong
> with it, and a staged plan to replace the fragile part with Ponder's
> built-in views pattern. It is a decision record, not a runbook — the
> active cutover runbook is still `docs/ponder-schema-cutover.md`, and
> the operational facts live in `AGENTS.md` ("Production database").

## TL;DR

- A `ponder_vN` is one full copy of all the indexer's derived tables in
  its own Postgres schema. A new version exists because **Ponder cannot
  migrate derived tables in place**: any change to `ponder.schema.ts`
  (a column, a table, a handler's output) forces a re-index from each
  contract's start block into a fresh schema.
- The versioning *itself* is a reasonable blue/green instinct. The mess
  is the plumbing around it: **two hand-maintained sources of truth for
  the schema name** (the writer's in Railway, the reader's in Netlify),
  **nothing dropping old schemas**, and **every step manual**.
- Ponder 0.16 (we run `^0.16.6`) ships the **views pattern**
  (`--views-schema`, since 0.11) and `ponder db prune`, which together
  remove the reader-flip, the two-sources-of-truth, and the
  reader-points-at-a-dead-schema bug class. We should adopt it.

## How it works today

### What a version is

Ponder isolates every deployment in a Postgres schema named by
`DATABASE_SCHEMA` / `--schema`. Raw chain data (logs, blocks, traces) is
cached once in the shared `ponder_sync` schema and is *not* re-fetched on
a re-index — so a version bump re-runs indexing logic over cached data
(CPU/DB-bound), it is not a fresh chain scan. The derived tables
(`collections`, `pnd_auctions`, `fnd_collections`, …) live in the
per-version schema.

### The version lifecycle (observed)

- **`ponder_v1`** — original. Frozen ~2026-07-15 at the cutover to v2.
  Dead; kept only for forensic comparison.
- **`ponder_v2`** — kept as the rollback schema.
- **`ponder_v3`** — current live (since 2026-09-04). This is the schema
  that froze on 2026-09-27 in the incident.
- **`ponder_v4`** — *planned*, for Surface v2 (adds `protocolVersion`,
  `royaltyLocked`, `ownerRenounced` to `collections` → schema change →
  re-index). Runbook: `docs/ponder-schema-cutover.md`.

So "four versions" is four schema-changing releases done blue/green,
with the old copies never dropped.

### The two sources of truth

The schema name is set **twice, by hand, in two systems**, and they must
be flipped in lockstep:

1. **Writer** — `DATABASE_SCHEMA` on the `indexer-vN` Railway service
   (uncommitted, in Railway service settings).
2. **Reader** — `INDEXER_SCHEMA` in Netlify's production context
   (uncommitted) *and* a hardcoded `DEFAULT_INDEXER_SCHEMA` fallback in
   two committed files (`apps/web/src/lib/indexer-schema.ts`,
   `scripts/check-indexer-schema.mjs`), plus the worker's own default in
   `apps/worker/src/indexer-schema.ts`.

Every web and worker query interpolates that one constant into raw SQL
(`FROM ${INDEXER_SCHEMA}.pnd_auctions`) — 21 interpolations in
`indexer-queries.ts` alone, ~17 web files and ~15 worker files in total.

## What's actually wrong

1. **Nothing couples reader to writer.** The whole class of "reader left
   pointing at a dead schema" is live. It already happened: Netlify
   carried a stale `INDEXER_SCHEMA=ponder_v1` for weeks after the v2
   cutover and silently served frozen data. The same landmine was still
   present on 2026-10-06 — the web `DEFAULT_INDEXER_SCHEMA` still read
   `ponder_v2` while live was `ponder_v3` (fixed in the PR that
   accompanies this doc).

2. **Old schemas are never dropped.** `ponder_v1` (dead ~3 months) and
   `ponder_v2` (stale rollback) still sit on maglev beside `ponder_v3`
   and `ponder_sync` — several full copies of the dataset. The
   DB-pressure firefight of 2026-09-26 (statement timeouts, "reduce DB
   usage", guarding every DB call) landed **one day before** `ponder_v3`
   froze. The bloat is a plausible direct contributor and should be
   treated as suspect until schema sizes are checked.

3. **Everything is manual** — `railway up` to deploy, hand-flip Netlify,
   hand-run parity SQL, no cleanup. Each step is a chance to desync.

4. **Defensive reader hacks exist only because of the fragility.**
   `indexer-queries.ts` probes `information_schema.columns` at runtime to
   see whether `pnd_auctions.version` exists, because the reader might be
   pointed at an older schema missing the column. With reader and writer
   always in sync, probes like this disappear.

5. **The safety net is all detection, no prevention.** The freshness
   check (`/api/health/indexer`), the studio banner, the build guard
   (`scripts/check-indexer-schema.mjs`), and `ponder-drift-check.ts` are
   all band-aids over "a human points the reader at a schema name." They
   catch the failure; they don't remove it. And the build guard only
   runs at Netlify *build* time, so a freeze *after* the last deploy (as
   on 2026-09-27) is invisible until someone redeploys — which is why the
   incident surfaced as a banner a user noticed 9 days later, not an
   alert.

## Why it's this way

Two forces, both real:

- **Ponder forces a re-index on schema change.** There is no in-place
  migration for derived tables. Given that, indexing the new shape into a
  *separate* schema while the old one keeps serving reads (blue/green) is
  the correct instinct: it gives zero-downtime cutover and a rollback.
- **The guards were added reactively** after the `ponder_v1` incident
  (PR #309: "single INDEXER_SCHEMA source, indexer freshness guard,
  build-time dead-schema check"). They hardened the manual process
  instead of replacing it, because the manual process was what existed.

The blue/green *strategy* is fine. The *manual coordination of two
schema names* is the defect.

## Options considered

- **A. Keep the manual scheme, add more guards.** Status quo plus e.g.
  alerting on the 503. Cheapest, but leaves every root cause in place.
- **B. Adopt Ponder's views pattern (recommended).** Indexer writes to a
  per-deploy schema and, on reaching realtime, atomically (re)creates
  views in a *stable* views schema. Readers query the stable schema
  forever. Removes root causes #1, #4, and most of #3. `ponder db prune`
  handles #2.
- **C. Switch to a different indexing stack** (subgraph, custom, etc.).
  Out of proportion to the problem; discard.

The re-index cost (and therefore the parallel-deploy blue/green shape) is
inherent to Ponder and survives in both A and B. B only removes the
*risky human coordination*, which is exactly the part that keeps breaking.

## Decision: adopt the views pattern, in stages

### Phase 0 — stabilize (operational, now)

Restart `indexer-v3` on Railway and root-cause the freeze. Note
`apps/indexer/railway.json` sets `restartPolicyMaxRetries: 5` — after 5
crashes Railway stops retrying and the service stays dead, which fits a
silent multi-day freeze. Check the crash logs and the DB's resource
state.

### Phase 1 — reclaim the DB (low risk, high value)

Once `ponder_v3` is confirmed healthy, **drop `ponder_v1` and
`ponder_v2`** (or run `ponder db prune`, which drops every non-active
Ponder deployment schema). Keep at most one rollback schema. This is the
direct answer to "why do we have v1 *and* v2 *and* v3" — v1/v2 should not
still exist — and likely relieves the pressure implicated in the freeze.
Do this *after* v3 has been stable for a bit, since v2 is the only
rollback today.

### Phase 2 — views pattern (removes the fragile architecture)

1. Run the indexer with `ponder start --schema <per-deploy> --views-schema <stable>`
   (e.g. a stable schema named `pnd`). Set this in the Railway service.
2. Point web and worker reads at the stable views schema **permanently**.
   Because every read funnels through the single `INDEXER_SCHEMA`
   constant, the code change is small: set that constant to the stable
   schema and stop ever changing it. Retire the `INDEXER_SCHEMA`-flip
   workflow, the hardcoded `DEFAULT_INDEXER_SCHEMA` version strings, and
   the build guard's reason for being (keep `/api/health/indexer` as pure
   monitoring). The `information_schema.columns` probes can likely be
   deleted once reader and writer shapes are guaranteed equal.
3. A future schema-changing release becomes: deploy the new indexer
   version → it indexes a fresh per-deploy schema → on realtime it
   repoints the views → `ponder db prune` the old one. **No Netlify
   change, no reader-points-at-dead-schema bug.** The `vN` numbers become
   an invisible implementation detail.

### Phase 3 — alerting (cheap, do regardless)

Wire the existing `/api/health/indexer` 503 to a monitor/pager so a
freeze pages someone in minutes. Optionally revisit the Railway restart
policy so the indexer doesn't permanently give up after 5 crashes
without notifying anyone.

## Web-side migration scope (for Phase 2)

Verified by tracing every schema reference:

- **Reads funnel through one constant.** All ~17 web files use
  `INDEXER_SCHEMA` from `apps/web/src/lib/indexer-schema.ts`, interpolated
  as `${INDEXER_SCHEMA}.<table>`. Pointing it at the stable views schema
  is a one-value change; no per-query rewrites.
- **Web reads only Ponder user tables**, never `ponder_sync`. Those
  tables are exactly what the views pattern mirrors into the views
  schema, so web reads are compatible with reading from views (views are
  read-only; web only reads).
- **Worker** reads the same user tables (compatible) and additionally
  reads/writes `ponder_sync` directly in `ponder-drift-check.ts`.
  `ponder_sync` is a separate shared schema untouched by the views
  pattern, so the drift-check keeps working as-is — though note the
  drift-check's whole purpose is a Ponder watch-set bug; re-evaluate
  whether it's still needed after the move.

## Open questions / risks (resolve before Phase 2)

- **Freshness read location.** Web reads `_ponder_checkpoint` from the
  configured schema for `/api/health/indexer`. Confirm how Ponder 0.16
  exposes checkpoint/meta under a views schema (it exposes a `_ponder_meta`
  view in some versions) and repoint the freshness read accordingly, or
  read it from the active deployment schema.
- **Permissions.** The web/worker DB role needs `USAGE` on the views
  schema and `SELECT` on the underlying deployment schemas' tables.
- **Realtime-gating.** Views are (re)created when a deployment reaches
  realtime. Verify the stable schema is never left pointing at a
  half-backfilled deployment during a cutover.
- **DB evidence.** The "bloat caused the freeze" link is circumstantial
  until maglev schema sizes and the `indexer-v3` crash logs are checked.

## Rollback

Phase 1 is irreversible per schema dropped — keep one prior version until
confident. Phase 2 is reversible: the per-version schemas still exist, so
reverting to a pinned `INDEXER_SCHEMA` restores the old behavior until the
views path is trusted.
