# PND v2 — Architecture

This doc exists because the single most confusing thing about v2 is that
**two separate programs both read the blockchain and both write to the
same Postgres database.** If you remember nothing else, remember that.

---

## The two indexing programs

### 1. Ponder (`apps/indexer/`)

An off-the-shelf indexing framework. You give it a fixed list of smart
contracts; it watches their events as new blocks arrive and writes rows.

- Writes into the **`ponder_v1` schema** (the `v1` is Ponder's own
  safe-redeploy namespace; see "Why ponder_v1" below).
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
  - `contract_identity`, `ens_identities` — contract + ENS lookups
  - `manifold_contracts` — Manifold contract classification cache
  - `worker_cursors`, `worker_iterations` — scan progress + audit log
- Runs on an internal scheduler (`setInterval`), one task per scan type.
- Every per-artist task is gated on `known_artists` — the spend ceiling.
- RPC: multi-provider fallback (`apps/worker/src/rpc.ts`):
  publicnode → llamarpc → ankr → drpc → Alchemy (last-resort backstop).

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
Ponder-owned equivalent (e.g. `ponder_v1.srv2_artist_tokens`) is a
DIFFERENT table written by program #1.

The web app reads BOTH:

```
discoverArtistTokenRefs(artist) =
    public.artist_tokens           (worker-owned: manifold/mint/tl/fnd-collection)
  UNION ponder_v1.fnd_artist_tokens   (Ponder-owned: Foundation shared 1/1)
  UNION ponder_v1.srv2_artist_tokens  (Ponder-owned: SuperRare V2 shared 1/1)
```

So a token shows on an artist page whether it came from the worker or
from Ponder.

---

## Why `ponder_v1`?

It's just the schema name Ponder writes into (set via `INDEXER_SCHEMA`).
The `v` is Ponder's safe-redeploy versioning: when Ponder's config or
schema changes materially, it can sync fresh into `ponder_v2`, `v3`, …
before flipping over, so a bad redeploy doesn't corrupt live data. You
may see empty `ponder_v2`/`ponder_v3` schemas on the DB — those are
abandoned re-sync attempts. The live data is in `ponder_v1`. Nothing to
fix; it's a namespace.

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
| Worker | publicnode | llamarpc → ankr → drpc → Alchemy | Alchemy only hit when free providers fail; bounded by known_artists × cadence |
| Web | n/a | — | **Never reads chain for storable data.** Only `lib/onchain.ts` (6 fns) for genuinely-live state (active bids, current owner), 30–60s pgCache |

Backfills are the expensive part. Steady-state (head-following +
incremental cursor scans) is trivial volume.
