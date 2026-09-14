# Ponder schema cutover: ponder_v3 to ponder_v4

This is a schema-changing indexer release. Follow the general procedure
in `AGENTS.md` ("Production database" and "Bumping the schema again"):
build a parallel `indexer-v4` Railway service writing a fresh
`ponder_v4` schema from genesis, verify parity against `ponder_v3`,
then flip `INDEXER_SCHEMA` in Netlify's production context and confirm
the flip through `/api/health/indexer`. This doc adds the checks
specific to the v4 change: Surface v2 support.

## What changed

- `apps/indexer/ponder.config.ts` adds `SurfaceFactoryV2`, `SurfaceV2`,
  and `FixedPriceMinterV2` to `contracts`, sourced from
  `contracts/deployments.mainnet.json`'s `surfaceFactoryV2` and
  `factoryDeployBlock` keys. If that file has no `surfaceFactoryV2` yet
  (the mainnet v2 broadcast has not happened), these three contracts are
  omitted and ponder_v4 indexes Surface v1 only, same as ponder_v3.
- `apps/indexer/ponder.schema.ts` adds three columns to `collections`:
  `protocolVersion` (integer, 1 for a v1 factory collection, 2 for v2),
  `royaltyLocked` (boolean), `sealed` (boolean). Every existing
  Surface v1 row gets `protocolVersion = 1`, `royaltyLocked = false`,
  `sealed = false` on replay, since `apps/indexer/src/Collections.ts`
  writes them explicitly on every `SurfaceCreated` insert (Ponder's
  onchain tables have no column defaults). `royaltyLocked`/`sealed` stay
  false for v1 rows for the life of the row: v1 has no `lockRoyalty` or
  `seal` function, so nothing ever flips them.
- `apps/indexer/src/Collections.ts` shares its handler functions between
  v1 and v2 contract names (byte-identical event shapes; see
  `docs/pnd-surface-v2-plan.md`), and adds two v2-only handlers
  (`SurfaceV2:RoyaltyLocked`, `SurfaceV2:OwnershipTransferred`) that
  update `royaltyLocked`/`sealed`.
- Also new: `apps/indexer/ponder.config.ts` accepts
  `PONDER_CHAIN_ID=11155111` with `SEPOLIA_RPC_URL` to run a
  sepolia-only instance indexing just the Surface v2 deploy there, for
  pre-mainnet verification. This mode is unrelated to the maglev
  `ponder_v3`/`ponder_v4` schemas and does not affect the mainnet
  cutover; every v1-only handler file gates on `MAINNET_MODE` (see
  `apps/indexer/src/chainMode.ts`) so it is a no-op outside mainnet mode.

## Parity checks before flipping INDEXER_SCHEMA

Run these against both `ponder_v3` and `ponder_v4` on maglev and compare.

Row counts per table (every table from ponder_v3 should match exactly,
since no v1 handler or event shape changed):

```sql
select 'collections' as table, count(*) from ponder_v3.collections
union all select 'collection_tokens', count(*) from ponder_v3.collection_tokens
union all select 'collection_mints', count(*) from ponder_v3.collection_mints
union all select 'collection_sales', count(*) from ponder_v3.collection_sales
union all select 'collection_referrals', count(*) from ponder_v3.collection_referrals
union all select 'minters', count(*) from ponder_v3.minters;
```

Repeat against `ponder_v4` with the same query (schema name swapped) and
diff the two result sets by hand or with a small script; every row count
must match.

`protocolVersion` distribution on `ponder_v4` (run only against v4,
`ponder_v3` has no such column):

```sql
select protocol_version, count(*) from ponder_v4.collections group by 1;
```

Expect every row at `protocol_version = 1` until the mainnet v2 factory
is deployed and `contracts/deployments.mainnet.json` is updated with
its `surfaceFactoryV2`/`factoryDeployBlock`; after that deploy and the
next `ponder_v4` replay, expect `protocol_version = 2` rows for every
collection created through the v2 factory, with zero rows at any other
value.

`royaltyLocked`/`sealed` sanity (only meaningful once v2 has live
collections; both columns are false on every v1 row by construction):

```sql
select protocol_version, royalty_locked, sealed, count(*)
from ponder_v4.collections
group by 1, 2, 3
order by 1, 2, 3;
```

## factory_addresses check for the v2 factory

Per `AGENTS.md`'s factory watch-set trap: confirm Ponder actually added
every v2 clone to its watch set, not just wrote the discovery row.

```sql
select factory_id, count(*)
from ponder_sync.factory_addresses
where factory_id ilike '%SurfaceFactoryV2%'
   or factory_id ilike '%SurfaceV2%'
   or factory_id ilike '%FixedPriceMinterV2%'
group by 1;
```

Compare the `SurfaceV2`/`FixedPriceMinterV2` counts against
`select count(*) from ponder_v4.collections where protocol_version = 2`:
they should match (one clone address per v2 collection, one minter
address per v2 collection with a canonical primary minter). A mismatch
means the same decayed-watch-set failure mode the v1 factories can hit:
run `apps/worker/src/tasks/ponder-drift-check.ts`'s repair path (see
`AGENTS.md`) before trusting the count.

Until the mainnet v2 factory is deployed, this section has nothing to
check: `contracts/deployments.mainnet.json` has no `surfaceFactoryV2`,
so `ponder.config.ts` omits `SurfaceFactoryV2`/`SurfaceV2`/
`FixedPriceMinterV2` from `ponder_v4` entirely and no v2 rows exist.

## Readiness check

After the parity checks pass, flip `INDEXER_SCHEMA=ponder_v4` in
Netlify's production context, redeploy, and confirm on the live site:

```
GET https://pnd.ripe.wtf/api/health/indexer
```

The response's configured schema must read `ponder_v4` and its
freshness timestamp must be recent (the build guard,
`scripts/check-indexer-schema.mjs`, already fails the build if the
schema does not exist or has gone stale, but confirm on the deployed
site rather than trusting the env var took effect from the Netlify UI
alone, per the ponder_v1 incident in `AGENTS.md`).
