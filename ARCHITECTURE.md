# PND v2 — Architecture

This doc exists because the single most confusing thing about v2 is that
**two separate programs both read the blockchain and both write to the
same Postgres database.** If you remember nothing else, remember that.

---

## The two indexing programs

### 1. Ponder (`apps/indexer/`)

An off-the-shelf indexing framework. You give it a fixed list of smart
contracts; it watches their events as new blocks arrive and writes rows.

- Writes into the schema named by **`INDEXER_SCHEMA`** (currently
  `ponder_v4`; the `vN` is Ponder's safe-redeploy namespace, see "Why
  `ponder_vN`?" below). Never hardcode the name.
- Owns a **fixed, small set of contracts** — things we want fully
  indexed regardless of who's involved:
  - `pnd_houses`, `pnd_auctions`, `pnd_bids` — PND auction houses
  - `fnd_auctions`, `fnd_buy_nows`, `fnd_sales` — Foundation marketplace
  - `fnd_artist_tokens` — Foundation shared 1/1 mints
  - `srv2_artist_tokens` — SuperRare V2 shared 1/1 mints
  - `fnd_collections`, `mint_creators`, `tl_creators` — discovery-only:
    "which artist deployed which contract" (NOT per-token data)
  - `catalog_contracts`, `catalog_tokens`, `catalog_ranges` — Catalog
- Good at: "watch these N specific contracts forever."
- Bad at: per-artist contracts. There are thousands of artist-deployed
  Manifold/Mint/TL clones; Ponder can't subscribe to thousands of
  addresses. That's what the worker is for.

### 2. The worker (`apps/worker/`)

A custom Node program **we wrote**. Also reads the chain, but writes into
the **`public` schema** — different tables, never touched by Ponder.

- Owns the **long tail + enrichment**:
  - `artist_tokens` — per-artist token data scanned from contracts the
    artist deployed (platforms: `manifold`, `mint`, `tl`, `fnd-collection`)
  - `token_metadata` — name/description/image (tokenURI + IPFS resolve)
  - `token_owners`, `token_transfers` — ownership + transfer history
  - `token_1155_transfers`, `token_1155_balances` — ERC-1155 ledger and
    per-holder balances (`scan-1155-balances`, migration 034)
  - `contract_identity`, `ens_identities` — contract + ENS lookups
  - `manifold_contracts` — Manifold contract classification cache
  - `worker_cursors`, `worker_iterations` — scan progress + audit log
- Runs on an internal scheduler (`setInterval`), one task per scan type.
- Every per-artist task is gated on `known_artists` — the spend ceiling.
- RPC: multi-provider fallback (`apps/worker/src/rpc.ts`):
  publicnode → tenderly → llamarpc → drpc → Alchemy (last-resort backstop).
- Scan integrity rules every cursored scanner follows (#295):
  - Walk ranges through `scan-range.ts`: a failing range is split and
    retried, never recorded as scanned.
  - Scan up to a **safe head**, not `latest` (`finality.ts`): the
    `finalized` tag, or `latest - SCAN_CONFIRMATIONS` (12) when a
    provider can't serve it. The live auction trackers use the
    confirmations head. Idempotent scanners replay `SCAN_REPLAY_OVERLAP`
    (12) blocks below their cursor.
  - Validate getLogs results before writing (`log-guard.ts`: in range,
    mined, no placeholder log index).
  - Cursor writes go through `cursors.ts` (`GREATEST`, never backwards).
  - A scope that keeps failing backs off exponentially (`backoff.ts`,
    `scan_backoff` table) instead of retrying every tick.
- `scan-token-transfers` batches contracts into multi-address getLogs
  (`transfer-batches.ts`) and backfills transfer history for tokens
  discovered after its cursor passed them (`transfer_backfill_queue`,
  fed by a trigger on `artist_tokens`; `transfer-backfill.ts`).
- `GET /health` is per task (`task-health.ts`): 503 when any task has
  failed 3 runs in a row, is running past its timeout, or hasn't run in
  3× its interval. `/metrics` adds backoff and backfill-queue summaries.
- Ownership (#296):
  - Shared Foundation / SR V2 1/1s: `scan-token-transfers` never scans
    those contracts. `mirror-shared-owners` copies Ponder's
    `<INDEXER_SCHEMA>.token_ownership` (ponder_v5+, every Transfer on
    both contracts) into `token_owners`, finalized blocks only, ordered
    by (block, log index), zero RPC. It is a no-op while the schema
    lacks the table. FND tokens minted before Ponder's FND start block
    that never moved since get one bounded `ownerOf` each, never a
    recurring sweep (`owner-mirror.ts` explains why one is enough).
  - ERC-1155: `scan-1155-balances` scans every TransferSingle /
    TransferBatch on the 1155 contracts known artists deployed (Mint
    clones, Manifold 1155 cores) into a raw ledger, and recomputes the
    touched tokens' balances from it in the same transaction, so replay
    and out-of-order ranges are idempotent (`erc1155-balances.ts`).
    `scan-1155-stats` derives `owner_count` from the balances once a
    contract has caught up.
  - Web: `getCollectorTokens` (reads.ts) unions `token_owners`, 1155
    balances and Surface `collection_tokens.owner` (guarded), keyset
    paginated; `GET /api/collector/[address]/holdings` serves it, each
    item hydrated with title, derivative artwork and attributed artist
    from Postgres (`profile-reads.ts`). It backs the Collected tab of the
    unified profile, `/artist/[address]?tab=available|created|collected|catalog`
    (#299; `profile-tabs.ts` has the tab rules). `/profile/[address]`
    and `/collector/[address]` redirect there.
- `prune-retention` (hourly) prunes expired `cache_entries`, old
  `worker_iterations`, stale `rate_limits` and `scan_backoff` rows.

### `known_artists` — bridges both

`known_artists` is a **VIEW** (saved query) in the `public` schema. It is
NOT owned by either program. It reads FROM Ponder's tables
(`pnd_houses.owner`, `fnd_collections.creator`, `mint_creators.address`,
`catalog_*.artist`, …) plus a manual `artist_seeds` table, and produces
"the addresses that have taken an explicit on-chain ecosystem action."
Currently ~155 addresses. Both programs read it. The worker scans
nothing for an address outside this set — that's how RPC spend stays
bounded by artist count, not by traffic. See migration `011`.

The view bakes in a Ponder schema name, so it must follow
`INDEXER_SCHEMA` across cutovers. Migration `028` adds
`pnd_known_artists_schema()` (which schema the view reads) and
`pnd_rebuild_known_artists(schema)`; the worker compares the two with
`INDEXER_SCHEMA` on startup and rebuilds the view if they differ
(`apps/worker/src/startup-checks.ts`).

---

## "The worker writes to artist_tokens" — what that actually means

When the docs/commits say *"the worker writes to `artist_tokens`,"* it
means: program #2 (the custom Node worker) inserts rows into the
`public.artist_tokens` table. Ponder never touches that table. The
Ponder-owned equivalent (e.g. `<INDEXER_SCHEMA>.srv2_artist_tokens`) is a
DIFFERENT table written by program #1.

The web app reads BOTH:

```
discoverArtistTokenRefs(artist) = one row per (contract, token_id) from
    public.artist_tokens                 (worker-owned: manifold/mint/tl/
                                          fnd-collection/fnd-shared)
  + <INDEXER_SCHEMA>.fnd_artist_tokens   (Ponder-owned: Foundation shared 1/1)
  + <INDEXER_SCHEMA>.srv2_artist_tokens  (Ponder-owned: SuperRare V2 shared 1/1)
```

So a token shows on an artist page whether it came from the worker or
from Ponder. The worker's `fnd-shared` rows and Ponder's
`fnd_artist_tokens` overlap for mints after Ponder's FND start block, so
the sources are deduped on `(contract, token_id)` with the worker row
winning (`apps/web/src/lib/artist-token-refs.ts`); a plain `UNION ALL`
double-counts them.

---

## Why `ponder_vN`?

It's just the schema name Ponder writes into (set via `INDEXER_SCHEMA`).
The `v` is Ponder's safe-redeploy versioning: when Ponder's config or
schema changes materially, it syncs fresh into the next `ponder_vN`
before flipping over, so a bad redeploy doesn't corrupt live data. The
live schema is `ponder_v4` (as of 2026-10); `ponder_v3` and `ponder_v2`
are rollback schemas and `ponder_v1` is dead (frozen since 2026-07-15).
See AGENTS.md "Production database" for the current list and
`docs/ponder-schema-cutover.md` for the cutover steps.

---

## Scope inconsistency to be aware of

Ponder indexes shared-contract mints (SR V2, Foundation 1/1) for
**everyone**, not just `known_artists`. That's why
`srv2_artist_tokens` has ~50K rows. Consequence: any SR V2 artist's page
works even if they're not a known artist.

The worker, by contrast, scans **only** `known_artists`. So per-artist
platforms (Manifold/Mint/TL) only populate for known artists.

This means the two halves have different "any artist's page works"
behavior. When deciding where to index a new platform, choose
deliberately:

- **Index via Ponder** = everyone's page works, but you pay to index
  every mint on the contract (expensive backfill for high-volume
  contracts).
- **Index via worker** = scoped to known_artists, cheap, but a
  non-known artist's page is empty until they join the set.

---

## RPC strategy

| Program | Primary | Fallbacks | Notes |
|---|---|---|---|
| Ponder | drpc free | (Ponder's own retry) | Backfill of high-volume contracts is the cost driver |
| Worker | publicnode | tenderly → llamarpc → drpc → Alchemy | Alchemy only hit when free providers fail; bounded by known_artists × cadence |
| Web | n/a | — | **Never reads chain for storable data.** Only `lib/onchain.ts` (6 fns) for genuinely-live state (active bids, current owner), 30–60s pgCache |

Backfills are the expensive part. Steady-state (head-following +
incremental cursor scans) is trivial volume.
