# Adding a new external NFT platform

How to add per-artist indexing for a third-party NFT platform
(KnownOrigin, Highlight, Async, Zora, etc.). Pattern is the same
across all of them — copy from SR V2, Transient Labs, or Manifold and
adjust.

This is for **external** platforms only — platforms you don't control,
where you want to surface artist work in the gallery + `/catalog`. For
contracts **you deploy yourself** (a Sovereign V2, a Catalog extension,
etc.), add them to Ponder — see existing patterns in `ponder/`.

## Architecture in one paragraph

The web app stores per-artist token rows in `lazy_<platform>_artist_tokens`
in Postgres. A daily cron (`/api/cron/refresh-external-indexes`) and a
"Refresh my work" button (`/api/refresh-artist/[address]`) both call
`refreshArtist(address)` in `apps/web/src/lib/external-indexer.ts`,
which calls one `scan<Platform>ArtistTokens(artist)` per platform.
Each scan reads its cursor from `lazy_<platform>_artist_status
.last_scanned_block`, fetches new on-chain events from chain head to
the cursor (bounded by `MAX_BLOCKS_PER_SCAN`), writes new rows, and
advances the cursor. The artist gallery and catalog pages read from
the per-platform tables via `discoverArtistTokens` on each adapter —
pure Postgres SELECTs, never external API calls.

Cost is bounded by the `known_artists` view (a UNION over on-chain
ecosystem activity in Ponder) — scans for addresses outside this set
short-circuit without spending a CU. The refresh button additionally
rate-limits at 5 minutes per artist (bypassed during catch-up of a
fresh artist with null cursors).

## Steps

### 1. SQL migration

Copy `db/migrations/006_lazy_superrareV2.sql` as a template. Rename to
`db/migrations/0NN_lazy_<platform>.sql`. Two tables:

```sql
CREATE TABLE IF NOT EXISTS lazy_<platform>_artist_tokens (
  creator          TEXT NOT NULL,
  contract         TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  block_number     BIGINT,        -- nullable if your source doesn't give it
  log_index        INTEGER,       -- nullable if your source doesn't give it
  -- ...any platform-specific columns (collection_name, etc.)
  last_indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (creator, contract, token_id)
);
CREATE INDEX IF NOT EXISTS lazy_<platform>_artist_tokens_creator_idx
  ON lazy_<platform>_artist_tokens (creator, block_number DESC);

CREATE TABLE IF NOT EXISTS lazy_<platform>_artist_status (
  creator             TEXT PRIMARY KEY,
  last_indexed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scanned_block  BIGINT       -- cursor; NULL = never scanned
);
```

Include `last_scanned_block` from the start (don't repeat the migration
023 pattern of adding it later).

If the platform needs additional caches (e.g., Manifold has
`lazy_manifold_contracts` for per-artist contract classification), add
those tables in the same migration with a descriptive header comment
explaining what they're for.

Apply with `npm run db:migrate`.

### 2. Lazy-index helpers

Add to `apps/web/src/lib/lazy-index.ts`. Pattern:

```ts
export type Lazy<Platform>ArtistToken = {
  contract: string
  tokenId: string
  blockNumber: bigint        // omit if not applicable
  logIndex: number           // omit if not applicable
  // ...other fields
}

export async function read<Platform>ArtistTokens(
  creator: string,
): Promise<{
  tokens: Lazy<Platform>ArtistToken[]
  lastIndexedAt: Date
  lastScannedBlock: bigint | null
} | null> {
  if (!sql) return null
  try {
    const status = await sql<...>`
      SELECT last_indexed_at, last_scanned_block::text AS last_scanned_block
      FROM lazy_<platform>_artist_status
      WHERE creator = ${creator.toLowerCase()}
      LIMIT 1
    `
    if (status.length === 0) return null
    const rows = await sql<...>`SELECT ... FROM lazy_<platform>_artist_tokens WHERE creator = ${...} ORDER BY ...`
    return {
      tokens: rows.map(/* ... */),
      lastIndexedAt: status[0].last_indexed_at,
      lastScannedBlock: status[0].last_scanned_block != null
        ? BigInt(status[0].last_scanned_block)
        : null,
    }
  } catch {
    return null
  }
}

export async function write<Platform>ArtistTokens(
  creator: string,
  tokens: Lazy<Platform>ArtistToken[],
  lastScannedBlock: bigint | null = null,
): Promise<void> {
  // AWAITABLE — async, returns Promise<void>. Never use the
  // `void (async () => { ... })()` fire-and-forget pattern. On Netlify
  // the route can tear down mid-write and lose the status-row INSERT.
  if (!sql) return
  try {
    for (const t of tokens) {
      await sql`INSERT INTO lazy_<platform>_artist_tokens ... ON CONFLICT DO UPDATE ...`
    }
    if (lastScannedBlock != null) {
      await sql`INSERT INTO lazy_<platform>_artist_status (creator, last_indexed_at, last_scanned_block)
                VALUES (${...}, NOW(), ${lastScannedBlock.toString()}::bigint)
                ON CONFLICT (creator) DO UPDATE
                  SET last_indexed_at = NOW(),
                      last_scanned_block = EXCLUDED.last_scanned_block`
    } else {
      await sql`INSERT INTO lazy_<platform>_artist_status (creator, last_indexed_at)
                VALUES (${...}, NOW())
                ON CONFLICT (creator) DO UPDATE SET last_indexed_at = NOW()`
    }
  } catch {
    /* ignore */
  }
}
```

**Critical**: the write helper MUST be `async`/awaitable and the scan
function MUST `await` it. The previous `void (async () => {...})()`
fire-and-forget shape caused PR #55's data-loss bug — token rows
persisted but the final status-row INSERT got killed by Netlify's
function teardown.

### 3. Adapter file

Create `apps/web/src/lib/platforms/<platform>.ts`. Two exports:

```ts
import { isKnownArtist } from "../known-artists"
import { MAX_BLOCKS_PER_SCAN } from "../external-indexer"
import { read<Platform>ArtistTokens, write<Platform>ArtistTokens } from "../lazy-index"
import type { PlatformAdapter, ArtistTokenRef } from "./types"

// (1) Pure-read adapter — what /catalog and /artist pages call.
// Never touches external APIs. Returns whatever's in Postgres.
export const <platform>Adapter: PlatformAdapter = {
  id: "<platform>",
  displayName: "Platform Display Name",
  async discoverArtistTokens(artist): Promise<ArtistTokenRef[]> {
    const cached = await read<Platform>ArtistTokens(artist)
    if (!cached) return []
    return cached.tokens.map((t) => ({
      platform: "<platform>",
      contract: t.contract as Address,
      tokenId: t.tokenId,
      blockNumber: t.blockNumber ?? null,
      logIndex: t.logIndex ?? null,
      collectionName: null,
    }))
  },
  // ...other methods (discoverCollectorTokens, getLastSale, etc.)
}

// (2) Scan function — the only path that hits external APIs.
// Called from refreshArtist in external-indexer.ts.
export async function scan<Platform>ArtistTokens(
  artist: Address,
): Promise<{ caughtUp: boolean }> {
  // Gate 1: known-artist allow-list. Random addresses cost zero.
  if (!(await isKnownArtist(artist))) return { caughtUp: true }

  // Cursor: pick up where we left off, or start from platform's
  // deploy block if first scan.
  const existing = await read<Platform>ArtistTokens(artist)
  const fromBlock = existing?.lastScannedBlock != null
    ? existing.lastScannedBlock + 1n
    : <PLATFORM_DEPLOY_BLOCK>

  // Bound to chain head. Bound further by MAX_BLOCKS_PER_SCAN so a
  // single call fits inside Netlify's 26s HTTP-function timeout.
  const client = getClient()
  const latest = await client.getBlockNumber()
  if (fromBlock > latest) {
    await write<Platform>ArtistTokens(artist, [], latest)
    return { caughtUp: true }
  }
  const budgetEnd = fromBlock + MAX_BLOCKS_PER_SCAN - 1n
  const toBlock = budgetEnd < latest ? budgetEnd : latest

  // Platform-specific scan logic. Read events from `fromBlock` to
  // `toBlock` (NOT `latest` — that's the budget cap).
  const refs = /* eth_getLogs / Alchemy getAssetTransfers / etc. */

  // Persist with the actual scan end as the new cursor.
  await write<Platform>ArtistTokens(artist, refs, toBlock)
  return { caughtUp: toBlock >= latest }
}
```

If your platform's discovery is complex enough to warrant its own file
(Manifold has separate `manifold-discovery.ts` for Etherscan + Alchemy
NFT API orchestration), put it there and re-export from the adapter.

### 4. Register the adapter

In `apps/web/src/lib/platforms/index.ts`, add to the `PLATFORMS` array.
This wires the adapter into the artist gallery's
`discoverArtistTokenRefs` aggregator.

### 5. Register the scan

In `apps/web/src/lib/external-indexer.ts`, three updates:

```ts
import { scan<Platform>ArtistTokens } from "./platforms/<platform>"

export async function refreshArtist(address: string): Promise<{ caughtUp: boolean }> {
  // ...
  const results = await Promise.all([
    scanSrv2ArtistTokens(lower).catch(() => ({ caughtUp: false })),
    scanTransientArtistTokens(lower).catch(() => ({ caughtUp: false })),
    scanManifoldArtistTokens(lower).catch(() => ({ caughtUp: false })),
    scan<Platform>ArtistTokens(lower).catch(() => ({ caughtUp: false })),  // ← new
  ])
  return { caughtUp: results.every((r) => r.caughtUp) }
}

export async function hasUnscannedPlatform(address: string): Promise<boolean> {
  // Add new platform's status row to the check
  const rows = await sql`
    SELECT
      (SELECT last_scanned_block FROM lazy_manifold_artist_status WHERE creator = ${...}) AS m,
      (SELECT last_scanned_block FROM lazy_srv2_artist_status     WHERE creator = ${...}) AS s,
      (SELECT last_scanned_block FROM lazy_tl_artist_status       WHERE creator = ${...}) AS t,
      (SELECT last_scanned_block FROM lazy_<platform>_artist_status WHERE creator = ${...}) AS p
  `
  return r.m === null || r.s === null || r.t === null || r.p === null
}

export type ArtistTokenCounts = {
  manifold: number
  srv2: number
  tl: number
  <platform>: number    // ← new
}

export async function countArtistTokens(address: string): Promise<ArtistTokenCounts> {
  // Add the new SELECT to the count query
}
```

### 6. Update the refresh button UI

In `apps/web/src/components/catalog/RefreshButton.tsx`:

- Add the platform to the `Counts` type
- Include it in `addedTotal` and `totalsTotal` calculations
- Mention it in the user-facing message strings (e.g., "on Manifold /
  SuperRare / Transient Labs / NewPlatform")

### 7. Deploy

```
npm run db:migrate          # apply your migration
git add ... && git commit
gh pr create ...
```

Once the PR merges and Netlify deploys, the new platform is live:
- Daily cron (04:00 UTC) starts including it for every known artist
- Refresh button starts scanning it on click
- Artist gallery surfaces its tokens via the adapter

No additional config or env vars needed.

## Gotchas (things that have bitten us)

- **Don't use fire-and-forget writes.** The `void (async () => {...})()`
  pattern caused PR #55's data-loss bug. Always `async function ...
  Promise<void>` and always `await`.

- **Don't call `after()` from page server components for external
  refreshes.** Netlify tears down the function before the callback
  completes. Use the route-handler + `maxDuration = 300` pattern in
  `/api/refresh-artist/[address]` instead. (Note: `maxDuration` still
  caps at ~26s on Netlify Pro for HTTP-triggered functions — that's
  why scans are chunked.)

- **Always gate on `isKnownArtist` before any external API call.**
  This is the single point of cost control. Without it, any visitor
  hitting `/artist/<random>` could trigger Alchemy spend.

- **Bound every scan call by `MAX_BLOCKS_PER_SCAN`.** Even if the
  platform's deploy block is recent, future drift could push the
  scan window past the function timeout.

- **Lowercase addresses everywhere.** Ponder lowercases on write;
  the lazy tables follow the same convention. Mixed-case lookups
  miss every row.

- **`ON CONFLICT DO NOTHING` (or `DO UPDATE`) on inserts** — re-orgs
  and concurrent scans can produce duplicates that violate primary keys.

- **For ERC-1155 platforms** (Manifold supports both), use
  `TransferSingle` + `TransferBatch` events with `from = 0x0` filter
  rather than ERC-721 `Transfer`. Edition mints share `tokenId`;
  `ON CONFLICT DO NOTHING` dedups them correctly.

## See also

- `DEPLOYMENT.md` — "External-platform indexer" section: cost model,
  cron scheduling, kill switch
- `apps/web/src/lib/known-artists.ts` — gate implementation
- `db/migrations/022_known_artists_view.sql` — `known_artists` view
  definition
- `apps/web/src/lib/platforms/superrareV2.ts` — simplest full example
  (single shared contract, no factory discovery)
- `apps/web/src/lib/platforms/transient.ts` — factory-pattern example
  (deployer event + per-clone Transfer scan)
- `apps/web/src/lib/manifold-discovery.ts` — most complex example
  (Etherscan contract discovery + classification cache + Alchemy
  asset transfers for incremental scans)
