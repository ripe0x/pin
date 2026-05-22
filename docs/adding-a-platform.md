# Adding a new external NFT platform

> **v2.** This doc was rewritten for the post-rebuild architecture
> (PR #69). Per-artist platform indexing now lives in **the worker**
> (`apps/worker/`), writing `public.artist_tokens`. The old v1 model —
> web-side `lazy_<platform>_artist_tokens` tables, a Netlify cron, and a
> "Refresh my work" button calling `refreshArtist()` — **no longer
> exists**. There are no `lazy_*` tables in the production DB. If you
> find instructions referencing `lazy-index.ts`, `external-indexer.ts`,
> `MAX_BLOCKS_PER_SCAN`, or web-side scanning, they are pre-rebuild.
> Read `ARCHITECTURE.md` first.

How to add per-artist indexing for a third-party NFT platform
(KnownOrigin, Highlight, Async, Zora, etc.).

## Decide first: worker scan, or Ponder?

This choice is the whole game (see `ARCHITECTURE.md` →
"Scope inconsistency"):

- **Per-artist clones / the long tail (the usual case)** → **worker
  scan**, gated on `known_artists`. Cheap; bounded by artist count, not
  traffic. A non-known artist's page is empty until they join the set.
  This is the path below.
- **A single fixed, shared contract you want indexed for *everyone***
  (like SuperRare V2's shared 1/1 contract) → add it to **Ponder**
  (`apps/indexer/`). Everyone's page works, but you pay to index every
  mint on that contract. Only do this for a small, bounded contract set.

**Never** subscribe Ponder to thousands of artist-deployed clones —
that's the unbounded backfill the rebuild deleted on purpose.

## Worker-scan path (per-artist)

The model: Ponder discovers *which artist deployed which contract* (a
factory → creators table, e.g. `tl_creators`, `mint_creators`,
`fnd_collections`). A worker task joins that discovery table against
`known_artists`, scans each clone's mint events incrementally behind a
cursor, and upserts `public.artist_tokens`. The web app reads
`artist_tokens` via `apps/web/src/lib/reads.ts` — pure Postgres, no
external calls.

Use `apps/worker/src/tasks/scan-tl-clones.ts` as the reference
implementation (simplest full example).

### 1. Discovery: get the artist→contract mapping into Ponder

If the platform deploys clones via a factory, add that factory to
`apps/indexer/ponder.config.ts` as a **discovery-only** contract (one row
per deploy, no per-clone event subscription) and write a handler that
inserts into a `<platform>_creators` table (`sender`/deployer, `contract`,
`first_seen_block`, contract type). Mirror the existing
`MintFactory`/`TLUniversalDeployer` handlers in `apps/indexer/src/`.

If the platform has no factory (artists use one shared contract), you
likely want the Ponder full-index path instead — see above.

### 2. Worker task: scan clones for known artists

Create `apps/worker/src/tasks/scan-<platform>-clones.ts`. Follow
`scan-tl-clones.ts`:

```ts
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { scanArtistTokensViaTransferFromZero } from "../scanners/transfer-from-zero.ts"
import type { TaskResult } from "../scheduler.ts"

const PLATFORM = "<platform>"
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1")
  .replace(/[^a-zA-Z0-9_]/g, "")

export async function scan<Platform>Clones(): Promise<TaskResult> {
  // Join the discovery table against known_artists — the spend ceiling.
  const targets = (await sql.unsafe(
    `SELECT lower(c.sender)          AS artist,
            lower(c.contract)        AS contract,
            c.first_seen_block::text AS deploy_block
     FROM ${INDEXER_SCHEMA}.<platform>_creators c
     JOIN known_artists k ON k.address = lower(c.sender)
     WHERE c.c_type LIKE 'ERC721%'`,   // ERC-1155 → erc1155-mints scanner
  )) as Array<{ artist: string; contract: string; deploy_block: string }>

  let totalRpc = 0, totalRows = 0
  for (const t of targets) {
    const r = await scanArtistTokensViaTransferFromZero({
      sql, client,
      taskName: "scan-<platform>-clones",
      platform: PLATFORM,
      artist: t.artist,
      contract: t.contract,
      contractDeployBlock: BigInt(t.deploy_block),
    }).catch((err) => {
      console.error(`[scan-<platform>-clones] ${t.artist}/${t.contract}:`, err)
      return { rpcCalls: 0, rowsWritten: 0 }
    })
    totalRpc += r.rpcCalls; totalRows += r.rowsWritten
  }
  return { scopeCount: targets.length, rpcCalls: totalRpc, rowsWritten: totalRows }
}
```

`scanArtistTokensViaTransferFromZero` (in
`apps/worker/src/scanners/transfer-from-zero.ts`) handles cursor
read/advance (`worker_cursors`), chunked `eth_getLogs` from the cursor to
head, and the `artist_tokens` upsert. For ERC-1155 platforms use
`scanners/erc1155-mints.ts` instead (TransferSingle/Batch from `0x0`).

### 3. Register the task

Add it to the scheduler in `apps/worker/src/scheduler.ts` with a sensible
cadence (the clone scanners run ~10m). That's it — the task ticks,
gated by `known_artists`, and writes `artist_tokens`.

### 4. Web reads it for free

`artist_tokens` is already aggregated into the artist gallery by
`apps/web/src/lib/reads.ts`. A new `platform` value flows through
automatically. If the platform needs a distinct display label or
last-sale logic, extend the relevant `reads.ts` query — but **do not add
any chain read under `apps/web/`** (the invariant; the only allowed
live-chain reads are the existing functions in `lib/onchain.ts`).

## Gotchas

- **Gate every scan on `known_artists`** (the SQL `JOIN`). This is the
  single point of RPC cost control — without it, the long tail is
  unbounded.
- **Respect the global RPC throttle.** All worker chain reads pace
  through `throttleRpc()` at ~2 req/s; don't bypass it for a "fast" scan.
- **Cursor-bound, chunked scans.** Never scan deploy-block→head in one
  `eth_getLogs`; the shared scanner already chunks. Persist the cursor so
  reruns are incremental.
- **Lowercase addresses everywhere.** Ponder lowercases on write;
  `known_artists` and `artist_tokens` follow suit. Mixed-case lookups
  miss every row.
- **Upsert, never plain insert.** Re-orgs and overlapping scan windows
  produce duplicates; `ON CONFLICT` dedups (the shared scanners do this).

## See also

- `ARCHITECTURE.md` — the two-program model and the cost-split rationale.
- `apps/worker/src/tasks/scan-tl-clones.ts` — reference clone scanner.
- `apps/worker/src/tasks/scan-mint-clones.ts`,
  `scan-fnd-collections.ts` — other discovery-driven scanners.
- `apps/worker/src/scanners/transfer-from-zero.ts`,
  `erc1155-mints.ts` — the shared scan engines.
- `db/migrations/011_known_artists_view.sql` — the `known_artists` view.
- `apps/indexer/ponder.config.ts` — factory/discovery contract definitions.
