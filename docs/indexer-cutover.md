# Ponder schema cutover

PND backfills every materially changed Ponder build into a new versioned
schema. Web and worker read the stable `indexer_live` alias, never a versioned
schema directly. `scripts/switch-indexer-schema.mjs` is the only supported way
to change that alias.

The switch is deliberately stricter than checking whether tables exist. It
requires the target Ponder app to report both `is_ready=1` and `is_locked=1`,
requires every table declared by the repository's current Ponder schema,
rejects row-count regressions, rejects missing PND factory children, and can
compare every house's indexed auction count with `nextAuctionId()` in one
Multicall3 request. Alias views, `known_artists`, and cutover state change in
one Postgres transaction.

The required-table gate includes the Surface release-state tables
`collection_supply_configs` and `minter_sale_configs`. A schema produced by an
older build cannot become live merely because its token counts look healthy.

## Current production baseline

As verified on 2026-08-29, maglev has migrations `001` through `024` applied.
Migration `016` is reconciled. Migrations `025` and `026` are pending. Apply
all repository migrations, including `027_indexer_control_plane.sql`, before
initializing the alias.

The live Ponder schema is `ponder_v2`. `ponder_v1` is stale and not ready; do
not use it as a cutover or rollback target. The live v2 data also has confirmed
PND factory/auction drift, so it is a count baseline only. It must not be made
the `indexer_live` target. Production's first alias cutover should go directly
from v2 to a clean, fresh v3 backfill.

## One-time alias initialization

For a healthy installation whose current versioned schema already passes every
guard, initialize the alias with the same schema as target and baseline:

```sh
DATABASE_URL=... node scripts/switch-indexer-schema.mjs \
  --target ponder_vN \
  --from ponder_vN \
  --verify-auctions
```

Do not use that command with production v2 because its confirmed drift makes
it ineligible. Follow the v3 recovery flow below, passing `--from ponder_v2` on
the first switch. Only after a successful switch, set
`INDEXER_SCHEMA=indexer_live` for Netlify web and the Railway worker. Ponder
itself continues to use its versioned `DATABASE_SCHEMA`; it never writes
through `indexer_live`.

## Fresh versioned backfill and forward cutover

1. Choose the exact next schema, for example `ponder_v3`. Never reuse an
   abandoned schema name.
2. Stop the current indexer, set its `DATABASE_SCHEMA` to `ponder_v3`, and
   deploy the intended commit. Existing alias-based installs keep reading the
   prior alias target. During production's first recovery, web and worker keep
   reading `ponder_v2` directly until the guarded switch succeeds.
3. Wait for `ponder_v3._ponder_meta` to report `is_ready=1` and `is_locked=1`.
   Do not infer readiness from process health alone.
4. Run the guarded switch:

   ```sh
   DATABASE_URL=... CUTOVER_RPC_URL=... \
     node scripts/switch-indexer-schema.mjs \
       --target ponder_v3 \
       --from ponder_v2 \
       --verify-auctions
   ```

   `--from` is required only while `public.indexer_state.active_schema` is
   empty. Later forward switches derive their baseline from that state row.

   `CUTOVER_RPC_URL` is optional. The script otherwise uses
   `PONDER_RPC_URL_1`, then Tenderly's public mainnet gateway. Auction parity
   is a single read-only multicall, not one request per house.
5. Read `public.indexer_state`, query representative `indexer_live` tables,
   and smoke-test artist, auction, collection, and token pages.
6. Keep the prior aliased schema intact as the rollback snapshot until the new
   release has cleared its observation window.

Production's first switch from direct v2 reads to the alias has no prior alias
snapshot, so `previous_schema` remains empty. Its rollback is an application
and environment rollback to the prior release and direct `ponder_v2` setting.
Once v3 is live through the alias, later versioned switches support the atomic
alias rollback below.

Never repair `ponder_sync.factory_addresses` manually. A missing child means
history may already be absent, and inserting an internal row cannot replay it.
Build a fresh schema instead.

## Rollback

Rollback requires a healthy indexer owning the rollback target. Stop the new
indexer and restart the exact prior build against the schema recorded in
`public.indexer_state.previous_schema`. Wait for that schema to report ready
and locked, then run, for example:

```sh
DATABASE_URL=... node scripts/switch-indexer-schema.mjs \
  --target ponder_v3 \
  --rollback \
  --verify-auctions
```

Rollback compares the target with the snapshot captured when it was last
live. It does not waive the readiness, table-completeness, factory-drift, or
auction-parity checks. A failed validation leaves every alias and state row
unchanged.

## Failure behavior

- A missing migration or `indexer_state` row stops before any DDL.
- A target that is backfilling, unlocked, incomplete, regressed, or drifted
  stops before any DDL.
- A view incompatibility rolls back the whole transaction.
- The worker drift task reports missing factory children as a failed
  iteration. It performs no repair write.
- `public.indexer_schema_snapshots` preserves the counts used to validate a
  later rollback.
