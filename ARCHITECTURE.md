# PND v2 — Architecture

This doc exists because the single most confusing thing about v2 is that
**two separate programs both read the blockchain and both write to the
same Postgres database.** If you remember nothing else, remember that.

---

## The two indexing programs

### 1. Ponder (`apps/indexer/`)

An off-the-shelf indexing framework. You give it a fixed list of smart
contracts; it watches their events as new blocks arrive and writes rows.

- Writes into a **versioned `ponder_vN` schema**. App readers use the stable
  `indexer_live` alias after a validated atomic cutover.
- Owns a **fixed, small set of contracts** — things we want fully
  indexed regardless of who's involved:
  - `pnd_houses`, `pnd_auctions`, `pnd_bids` — PND auction houses
  - `fnd_auctions`, `fnd_buy_nows`, `fnd_sales` — Foundation marketplace
  - `fnd_artist_tokens` — Foundation shared 1/1 mints
  - `srv2_artist_tokens` — SuperRare V2 shared 1/1 mints
  - `fnd_collections`, `mint_creators`, `tl_creators` — discovery-only:
    "which artist deployed which contract" (NOT per-token data)
  - `catalog_contracts`, `catalog_tokens`, `catalog_ranges` — Catalog
  - `surface_collections`, `surface_tokens`, `collection_supply_configs`,
    `minter_sale_configs` — fixed PND Surface creation and live release state
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
  - `contract_identity`, `ens_identities` — contract + ENS lookups
  - `manifold_contracts` — Manifold contract classification cache
  - `worker_cursors`, `worker_iterations` — scan progress + audit log
- Runs on an internal scheduler (`setInterval`), one task per scan type.
- Every per-artist task is gated on `known_artists` — the spend ceiling.
- RPC: multi-provider fallback (`apps/worker/src/rpc.ts`):
  publicnode → tenderly → llamarpc → drpc → Alchemy (last-resort backstop).

### `known_artists` — bridges both

`known_artists` is a **VIEW** (saved query) in the `public` schema. It is
NOT owned by either program. It reads FROM Ponder's tables
(`pnd_houses.owner`, `fnd_collections.creator`, `mint_creators.address`,
`catalog_*.artist`, …) plus a manual `artist_seeds` table, and produces
"the addresses that have taken an explicit on-chain ecosystem action."
Currently ~155 addresses. Both programs read it. The worker scans
nothing for an address outside this set — that's how RPC spend stays
bounded by artist count, not by traffic. See migration `011`.

---

## "The worker writes to artist_tokens" — what that actually means

When the docs/commits say *"the worker writes to `artist_tokens`,"* it
means: program #2 (the custom Node worker) inserts rows into the
`public.artist_tokens` table. Ponder never touches that table. The
Ponder-owned equivalent (e.g. `indexer_live.srv2_artist_tokens`) is a
DIFFERENT table written by program #1.

The web app reads BOTH:

```
discoverArtistTokenRefs(artist) =
    public.artist_tokens           (worker-owned: manifold/mint/tl/fnd-collection)
  UNION indexer_live.fnd_artist_tokens   (Ponder-owned: Foundation shared 1/1)
  UNION indexer_live.srv2_artist_tokens  (Ponder-owned: SuperRare V2 shared 1/1)
```

So a token shows on an artist page whether it came from the worker or
from Ponder.

---

## Versioned Ponder schemas and `indexer_live`

Ponder writes into the schema named by its `DATABASE_SCHEMA`, such as
`ponder_v3`. A replacement index can backfill beside the active one without
corrupting live reads. Web and worker do not follow that version string.
They read `INDEXER_SCHEMA=indexer_live`, a schema of views atomically repointed
only after readiness, structure, row-count, factory-child, and optional auction
parity checks pass. See `docs/indexer-cutover.md`.

As of 2026-08-29, production has a confirmed pre-cutover split between stale
web `ponder_v1` and Railway `ponder_v2`. The documented recovery is a fresh
Ponder 0.17.3+ backfill and guarded alias cutover, not selecting either schema
by hand and not mutating `ponder_sync`.

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
