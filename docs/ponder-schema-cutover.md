# Ponder schema cutover: ponder_v4 to ponder_v5

This is a schema-changing indexer release. Follow the general procedure
in `AGENTS.md` ("Production database" and "Bumping the schema again"):
build a parallel `indexer-v5` Railway service writing a fresh
`ponder_v5` schema from genesis, verify parity against `ponder_v4`,
then flip `INDEXER_SCHEMA` in Netlify's production context and confirm
the flip through `/api/health/indexer`. `indexer-v4`/`ponder_v4` stay as
the rollback pair. This doc adds the checks specific to the v5 change:
the indexer rebinds from the superseded first Surface v2
(`SurfaceFactoryV2`/`SurfaceV2`/`FixedPriceMinterV2`, never on mainnet)
to the primitive-first Surface v2 (`docs/pnd-surface-v2-design.md`).

## What changed

- `apps/indexer/ponder.config.ts` declares five v2 contracts:
  `SurfaceTokenFactoryV2` and `SurfaceSaleFactoryV2` (two instances of
  `CloneFactory`, discovery via `Created`), `LauncherV2` (`Launched`),
  and the clones as factory() children of their own factory:
  `SurfaceV2` (token, child address `Created.instance` of the token
  factory) and `FixedPriceSaleV2` (sale, `Created.instance` of the sale
  factory). Addresses and start block come from
  `contracts/deployments.<network>.json` keys `surfaceFactoryV2` (token
  factory), `saleFactoryV2`, `launcherV2` and `factoryDeployBlock`. A
  network gets sources only once all three addresses are recorded; until
  then its key is omitted from each `chain: {...}` map (no source, no
  `eth_getLogs`, no `ponder_sync.factories` row). The sepolia entries are
  included only with `INDEX_SEPOLIA=1` or in sepolia-only mode.
- `apps/indexer/ponder.schema.ts` `collections`: drops `royaltyLocked`
  (v2 has no royalty lock; no reader), adds `ownerConfirmed` (v2 only,
  null for v1) and `launcher` (v2 only). `minters` now also maps a v2
  sale to its collection.
- `apps/indexer/src/Collections.ts` v2 handlers:
  - token `Created`: one multicall (a single `eth_call`) reads
    `owner/name/symbol/minter` at the creation block, inserts the
    collection with `protocol_version = 2`. `ownerConfirmed` starts true
    only if the owner sent the transaction.
  - sale `Created`: one `eth_call` reads `collection()`; the sale is
    recorded in `minters` only if that collection is a v2 `collections`
    row (so a sale bound to a collection the token factory never made is
    ignored, along with its `Sold`).
  - `Launched`: sets `collections.launcher`. `Launched.owner` is the
    caller's claim, not consent, and is not used.
  - token `MinterSet` (updates `primary_minter`), `NameSet` (updates
    name/symbol), `RendererSet`/`SupplyCapSet`/`RoyaltySet`: each marks
    `ownerConfirmed` true. `OwnershipTransferred` moves the owner and
    resets `ownerConfirmed` unless the new owner sent the transaction.
    The clone's own init logs precede `Created` in the same transaction
    and are skipped because the row does not exist yet.
  - `Minted`/`Burned` (token), `Sold`/`ReferralPaid` (sale) into the
    existing `collection_*` tables.
- `apps/worker/src/tasks/ponder-drift-check.ts` repairs v1 and v2 watch
  sets separately by `protocol_version` (before, every `collections`
  row was repaired into the v1 Surface factory's stream, which would
  subscribe a v2 collection under the v1 ABI), and adds the two v2
  streams (`topic2` of each CloneFactory) once `@pin/addresses` carries
  `SURFACE_TOKEN_FACTORY_V2` / `SALE_FACTORY_V2` for mainnet.

RPC cost: two `eth_call`s per v2 launch (one multicall on the token, one
read on the sale), at the creation block, cached in `ponder_sync`. No
per-mint reads.

## Parity checks before flipping INDEXER_SCHEMA

Row counts per table must match exactly between `ponder_v4` and
`ponder_v5` for everything v1 (no v1 handler or event shape changed).
Run against both schemas and diff:

```sql
select 'collections' as table, count(*) from ponder_v4.collections where protocol_version = 1
union all select 'collection_tokens', count(*) from ponder_v4.collection_tokens
union all select 'collection_mints', count(*) from ponder_v4.collection_mints
union all select 'collection_sales', count(*) from ponder_v4.collection_sales
union all select 'collection_referrals', count(*) from ponder_v4.collection_referrals
union all select 'minters', count(*) from ponder_v4.minters;
```

`ponder_v4` has no v2 rows on mainnet (the superseded v2 factory never
deployed there). While the mainnet v2 factories stay paused, `ponder_v5`
should match `ponder_v4` exactly. Once collections exist:

```sql
select protocol_version, owner_confirmed, (launcher is not null) as launched, count(*)
from ponder_v5.collections group by 1, 2, 3 order by 1, 2, 3;
```

## factory_addresses check for the v2 factories

Per `AGENTS.md`'s factory watch-set trap, confirm every v2 clone is in
the watch set, not just in the discovery table. `ponder_sync.factories.id`
is not stable across a replay, so resolve it by factory address:

```sql
select id, factory->>'address' as factory, factory->>'childAddressLocation' as loc
from ponder_sync.factories
where lower(factory->>'address') in (
  lower('<surfaceFactoryV2 from deployments.mainnet.json>'),
  lower('<saleFactoryV2 from deployments.mainnet.json>')
);
```

Both rows should read `loc = topic2`. Count each id's addresses in
`ponder_sync.factory_addresses` (`chain_id = 1`) and compare: the token
factory id against
`select count(*) from ponder_v5.collections where protocol_version = 2`,
the sale factory id against
`select count(*) from ponder_v5.minters m join ponder_v5.collections c on c.collection = m.collection where c.protocol_version = 2`.
The sale stream may be larger (it also watches sales bound to
collections the token factory never made, which handlers ignore); the
token stream must match exactly. A shortfall means a decayed watch set:
run `ponder-drift-check.ts`'s repair path before trusting the count.

## Sepolia verification mode

`PONDER_CHAIN_ID=11155111` restricts the indexer to the sepolia chain
and the Surface v2 contracts (`SurfaceTokenFactoryV2`,
`SurfaceSaleFactoryV2`, `LauncherV2`, `SurfaceV2`, `FixedPriceSaleV2`), for verifying a live sepolia deploy without
touching mainnet. Unset (or `1`), the default, is production mode:
every chain and contract in `ponder.config.ts`, unchanged.

Run it with:

```
PONDER_CHAIN_ID=11155111 \
SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co \
DATABASE_URL=postgres://<user>@localhost:5432/<db> \
npx ponder dev --schema <a schema name, max 45 characters> --disable-ui
```

`PONDER_RPC_URL_1` is not required in this mode. `HOMAGE_WIRED` and
`SOVEREIGN_V2_WIRED` are forced false in this mode even if their env
vars are set: both are mainnet-only singletons.

Every mainnet-only contract keeps its key in `contracts` (so
`ponder.on(...)` registrations for those contracts elsewhere in the
codebase keep typechecking against real per-event argument types, not
`unknown`), but its `chain` map is empty in this mode
(`SEPOLIA_ONLY_MODE ? {} : "mainnet"`), the same "omit the key, not a
placeholder address" mechanism the Surface v2 contracts already use per
network above: an empty chain map
contributes no source, no `eth_getLogs` call, and no
`ponder_sync.factories` row. `chains.mainnet` itself is also omitted in
this mode, not just left with no contracts on it: a declared chain gets
an `eth_getBlockByNumber "latest"` call at startup regardless of
whether any contract subscribes to it, so leaving `mainnet` declared
would still send one mainnet RPC request.

Schema naming: use a schema name distinct from any parity/production
schema (`ponder_v4`, `ponder_v5`, …) so a sepolia-only run never
collides with a real replay. `apps/indexer/scripts/
check-config-parity.ts` (`pnpm check:config-parity`) proves this mode
does not change the config production mode produces, by diffing the
current file's mainnet-mode output against the `origin/main` version.
The script sets `INDEX_SEPOLIA=1`, so it compares the full config
including the sepolia entries.

## Readiness check

After the parity checks pass, flip `INDEXER_SCHEMA=ponder_v5` in
Netlify's production context, redeploy, and confirm on the live site:

```
GET https://pnd.fyi/api/health/indexer
```

The response's configured schema must read `ponder_v5` and its
freshness timestamp must be recent (the build guard,
`scripts/check-indexer-schema.mjs`, already fails the build if the
schema does not exist or has gone stale, but confirm on the deployed
site rather than trusting the env var took effect from the Netlify UI
alone, per the ponder_v1 incident in `AGENTS.md`).
