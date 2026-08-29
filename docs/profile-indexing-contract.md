# Profile and indexing contract

PND profiles are a view of indexed onchain evidence. They must say what PND
knows, what is currently available, and how fresh that conclusion is without
making a chain request for every tile.

## Read and write boundaries

- The web reads Postgres for artist inventory, ownership, metadata, and sale
  availability. A gallery request must not scan logs or poll a marketplace.
- Ponder indexes fixed shared contracts and discovers artist-deployed
  contracts. The worker scans the per-artist long tail, gated by
  `known_artists`.
- Worker scanners commit only finalized ranges. A provider that does not
  support the `finalized` tag falls back to head minus 64 confirmations.
- A scan range and its cursor update commit in one transaction. Any log,
  multicall, or SQL failure leaves the cursor unchanged for retry.

## Artist inventory and availability

An indexed work means PND has durable creation evidence from Foundation,
Manifold, Mint, PND, SuperRare, or Transient Labs. It does not imply that the
work is owned by the artist or available for sale.

Availability is a separate normalized record:

- `listed`: an auction is waiting for its first bid.
- `active`: an auction has a bid and its end time is in the future.
- `buy-now`: a fixed-price listing is active.
- `settling`: bidding ended and settlement is still pending. This state is not
  counted as available now.

PND Surface primary releases are a separate availability class. The fixed
Surface factory, collection, and minter event streams materialize
`surface_collections`, `collection_supply_configs`, and
`minter_sale_configs` in Ponder. A release is open only while its indexed mint
window is active and both the collection supply cap and minter sale cap have
remaining room. This adds no request-time or worker RPC calls.

PND and Foundation availability comes from indexed lifecycle events.
SuperRare and Transient Labs availability comes from worker observations and
is hidden when its latest observation is more than 15 minutes old. Gallery
ranking is computed across the artist's complete inventory before SQL
pagination, so an older listing cannot be stranded on a later page.

The created-work archive says `sold` only when a completed Foundation sale or
settled PND auction records the attributed creator as seller. A bare transfer
is labeled `transferred`, and a zero-address transfer is labeled `burned`.
This intentionally avoids turning gifts, vault moves, migrations, and custody
changes into false sales.

## Ownership and collector identity

Creation and collection are independent roles. A wallet may be both an artist
and a collector. `work_attributions` preserves many-to-many indexed mint or
contract-authority evidence, including collaborations; Catalog declarations
remain separate artist-authored context. Collector holdings come from the
current ownership model. Burned tokens and zero-address balances are never
collector holdings. Incomplete ownership coverage must be labeled instead of
being presented as an empty collection.

## Durable artist refresh

The web inserts `refresh_jobs` before notifying the worker. The state machine
is `queued -> running -> complete | partial | failed`. The worker claims queued
or expired-running jobs with `FOR UPDATE SKIP LOCKED`, maintains a lease, and
stores per-source results and errors. Duplicate queued/running jobs for one
artist are forbidden.

The first web status poll that observes `complete` or `partial` invalidates the
artist-specific refs and enrichment cache tags, then records
`cache_invalidated_at`. A worker restart cannot lose an accepted job, and a
browser reload can poll the same job id.

## Cost and release evidence

Run the deterministic tests before release:

```sh
RPC_DELAY_MS=0 node --test --experimental-strip-types \
  apps/worker/src/finality.test.ts \
  apps/worker/src/scanner-contracts.test.ts
pnpm --filter @pin/web test
pnpm --filter @pin/worker typecheck
pnpm --filter @pin/web typecheck
```

Then check production telemetry without mutating it:

```sh
DATABASE_URL=... node scripts/check-worker-cost.mjs \
  --days=7 \
  --max-rpc-per-day=50000 \
  --max-rpc-per-scope=100 \
  --max-iteration-rpc=10000 \
  --max-error-rate=0.05
```

The check reads both `worker_daily_metrics` and unaggregated
`worker_iterations`, avoids double-counting task-days already rolled up, and
exits 1 on a threshold violation. Thresholds also accept the corresponding
`WORKER_COST_*` environment variables. Exit 2 means configuration, schema, or
database access failed.

Release evidence is complete only when the indexer alias points to a ready,
locked build; worker and web report `INDEXER_SCHEMA=indexer_live`; migrations
027 through 034 are applied; indexed ownership and attribution mirrors have
caught up; refresh reclamation is exercised; SR/TL
observations remain within the 15-minute window; and the cost check passes for
the chosen observation period.
