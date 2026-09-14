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
  and `FixedPriceMinterV2` to `contracts`. Each is declared once, with
  Ponder's per-chain `chain: { mainnet: {...}, sepolia: {...} }`
  override: a network's key is present, with the real address and
  block from `contracts/deployments.mainnet.json` or
  `contracts/deployments.sepolia.json`'s `surfaceFactoryV2`/
  `factoryDeployBlock`, only once that network has a deployment
  recorded. A network with no deployment yet has its key omitted
  entirely, not pointed at a placeholder address: Ponder's
  `flattenSources` builds one source per key present in `chain`, so an
  omitted network gets no source, no `eth_getLogs` call, and no
  `ponder_sync.factories` row. `chains.sepolia` is always configured
  (`SEPOLIA_RPC_URL`, falling back to a free public RPC when unset), so
  the sepolia rehearsal deploy is indexed by the same `ponder_v4`
  schema as mainnet, not a separate run, once it is deployed there.
- `apps/indexer/ponder.schema.ts` adds three columns to `collections`:
  `protocolVersion` (integer, 1 for a v1 factory collection, 2 for v2),
  `royaltyLocked` (boolean), `ownerRenounced` (boolean). Every existing
  Surface v1 row gets `protocolVersion = 1`, `royaltyLocked = false`,
  `ownerRenounced = false` on replay, since `apps/indexer/src/
  Collections.ts` writes them explicitly on every `SurfaceCreated`
  insert (Ponder's onchain tables have no column defaults).
  `royaltyLocked` stays false for v1 rows for the life of the row: v1
  has no `lockRoyalty` function, so nothing ever flips it.
  `ownerRenounced` tracks `OwnershipTransferred` to the zero address for
  BOTH versions (v2's `seal()` reaches it, and v1's OZ Ownable2Step base
  still allows a direct `renounceOwnership` call).
- `apps/indexer/src/Collections.ts` shares its handler functions between
  v1 and v2 contract names (byte-identical event shapes; see
  `docs/pnd-surface-v2-plan.md`), and adds one v2-only handler
  (`SurfaceV2:RoyaltyLocked`) plus one shared handler registered for
  both `Surface:OwnershipTransferred` and
  `SurfaceV2:OwnershipTransferred`.

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

Expect every mainnet row at `protocol_version = 1` until the mainnet v2
factory is deployed and `contracts/deployments.mainnet.json` is updated
with its `surfaceFactoryV2`/`factoryDeployBlock`; after that deploy and
the next `ponder_v4` replay, expect `protocol_version = 2` rows for
every collection created through the mainnet v2 factory. A sepolia
rehearsal deploy also produces `protocol_version = 2` rows; distinguish
mainnet from sepolia collections by joining `collection_mints.block_number`
against each chain's known block ranges, or by the collection address
against the two deploy records, since `collections` does not carry a
chain id column.

`royaltyLocked`/`ownerRenounced` sanity (only meaningful once v2 has
live collections; both columns are false on every v1 row by
construction):

```sql
select protocol_version, royalty_locked, owner_renounced, count(*)
from ponder_v4.collections
group by 1, 2, 3
order by 1, 2, 3;
```

## factory_addresses check for the v2 factory

Per `AGENTS.md`'s factory watch-set trap: confirm Ponder actually added
every v2 clone to its watch set, not just wrote the discovery row.
`ponder_sync.factories.id` is a Ponder-assigned integer, not stable
across a replay, so resolve it the same way
`apps/worker/src/tasks/ponder-drift-check.ts` does: match the factory's
own address (recorded as `surfaceFactoryV2` in the relevant
`contracts/deployments.<network>.json`) and, for Surface's two child
streams off the same `SurfaceCreated` log, the `childAddressLocation`
that distinguishes them (`topic2` for the collection stream matching
`parameter: "collection"`, `offset0` for the minter stream matching
`parameter: "primaryMinter"`):

```sql
select id, factory->>'childAddressLocation' as child_address_location
from ponder_sync.factories
where lower(factory->>'address') = lower('<surfaceFactoryV2 from deployments.mainnet.json>');
```

Take the two returned ids (one per `child_address_location`) and count
their watched addresses:

```sql
select factory_id, count(*)
from ponder_sync.factory_addresses
where chain_id = 1
  and factory_id in (<collection_stream_id>, <minter_stream_id>)
group by 1;
```

Compare the `topic2` (collection stream) count against
`select count(*) from ponder_v4.collections where protocol_version = 2`
for mainnet collections only, and the `offset0` (minter stream) count
against
`select count(*) from ponder_v4.minters m join ponder_v4.collections c on c.collection = m.collection where c.protocol_version = 2`,
scoped the same way. They should match exactly. A mismatch means the
same decayed-watch-set failure mode the v1 factories can hit: run
`ponder-drift-check.ts`'s repair path (see `AGENTS.md`) before trusting
the count. Repeat the same two queries with the sepolia deploy record
and `chain_id = 11155111` to check the rehearsal deploy's watch set too.

Until a network's deploy record has a `surfaceFactoryV2`, that
network's key is omitted from the contract's `chain: {...}` map (see
"What changed" above), so it has no `ponder_sync.factories` row at all
on that chain, and there is nothing to compare there yet.

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
