# Ponder schema cutover: ponder_v4 to ponder_v5

This is a schema-changing indexer release. Follow the general procedure
in `AGENTS.md` ("Production database" and "Bumping the schema again"):
build a parallel `indexer-v5` Railway service writing a fresh
`ponder_v5` schema from genesis, run the parity gate against
`ponder_v4`, then flip `INDEXER_SCHEMA` on BOTH Netlify production and
the Railway worker and confirm the flip through `/api/health/indexer`.
`indexer-v4`/`ponder_v4` stay as the rollback pair. This doc adds the
checks specific to the v5 change: the indexer rebinds from the
superseded first Surface v2 (`SurfaceFactoryV2`/`SurfaceV2`/
`FixedPriceMinterV2`, never on mainnet) to the primitive-first Surface
v2 (`docs/pnd-surface-v2-design.md`), and the same replay adds owner
tracking and the v1 creator roster.

Surface v2 is live on mainnet: the token and sale factories are open
(not paused), and Form of Solitude launched through the Launcher in
block 26,325,534 and has been selling since. `ponder_v4` cannot see any
of it (it binds the superseded ABI), so `ponder_v5` is a superset of
`ponder_v4`, not a copy: it carries v2 `collections`/`minters`/
`collection_*` rows plus new tables and columns. Every v1 row must still
match.

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
    resets `ownerConfirmed` unless the new owner sent the transaction; a
    renounce keeps it (see below).
    The clone's own init logs precede `Created` in the same transaction
    and are skipped because the row does not exist yet.
  - `Minted`/`Burned` (token), `Sold`/`ReferralPaid` (sale) into the
    existing `collection_*` tables.
- `apps/worker/src/tasks/ponder-drift-check.ts` checks v1 and v2 watch
  sets separately by `protocol_version` (before, every `collections`
  row went to the v1 Surface factory's stream, which would subscribe a
  v2 collection under the v1 ABI), and adds the two v2 streams
  (`topic2` of each CloneFactory) once `@pin/addresses` carries
  `SURFACE_TOKEN_FACTORY_V2` / `SALE_FACTORY_V2` for mainnet.

## Also in this replay (additive; web on ponder_v4 is unaffected)

- **Renounce keeps consent.** `SurfaceV2:OwnershipTransferred` to
  `address(0)` keeps the previous `owner_confirmed` (true if it was
  null): only the owner can call `renounceOwnership()`. Before, a
  renounce always wrote false, and `owner_confirmed IS NOT FALSE`
  listings hid every sealed collection. A Safe or other contract owner
  still starts unconfirmed (`tx.from` is the executing EOA) until its
  first owner-only setter. Rules and tests: `apps/indexer/src/ownership.ts`.
- **`collection_tokens.owner`, `owner_updated_at_block`** (v1 and v2):
  the current holder, seeded from `Minted.to`, moved by every ERC-721
  `Transfer`, `0x0` once burned, reset by a pooled re-mint. Complete for
  every Surface token: the clones are factory children, so their Transfer
  stream is indexed from creation. `minted_to` stays the mint recipient,
  and transfers do not move `updated_at_block/time` (readers order by
  them as mint time).
- **`token_ownership`**: current owner for the two shared 1/1 contracts,
  one row per `(contract, token_id)`, upserted by every Transfer.
  Coverage boundary:
  - `SuperRareNFT` (`source = 'superrare-v2'`): subscribed from block
    8,000,000, below the contract's deploy. Complete.
  - `FoundationNFT` (`source = 'foundation-shared'`): subscribed from
    `FND_START_BLOCK` = 24,973,294, not the contract's deploy. Complete
    for every token minted since (every `fnd_artist_tokens` row); an
    older token has a row only if it moved after that block. An older
    token with no row keeps the worker's `public.token_owners` as its
    source.
  Nothing mirrors this into `public.token_owners` yet (the worker side of
  issue #296 is a follow-up).
- **`collection_creators`** (issue #261): v1 `Surface:CreatorListed
  (address indexed creator, bool listed)`, one row per
  `(collection, creator)` with the latest `listed`. Not gated on the
  `collections` row, since initialize emits the creation-time listings
  before `SurfaceCreated`. Join with `catalog_contracts` for the
  confirmed state.
- **Drift check** (`apps/worker/src/tasks/ponder-drift-check.ts`) is now
  detect-and-alert by default: drift fails the iteration and names the
  stream. `PONDER_DRIFT_REPAIR=1` opts into inserting the missing rows,
  which only takes effect at the next indexer restart and never replays
  past events. Factory rows are resolved deterministically for the
  worker's `INDEXER_SCHEMA` (address, location, event selector, chain,
  then best overlap with that schema's rows), not first match in the
  shared `ponder_sync`.

RPC cost: two `eth_call`s per v2 launch (one multicall on the token, one
read on the sale), at the creation block, cached in `ponder_sync`. No
per-mint reads. The Transfer handlers add log filters only: Surface
clones were already subscribed; `FoundationNFT` gains a Transfer filter
over the same window as its `Minted` filter.

## Before you start

- **Never redeploy `indexer-v4` from `main` once #358 has merged.**
  Ponder's build id hashes the contracts, schema and indexing files, and
  an existing schema refuses a different build id, so a v4 redeploy or
  rollback from post-#358 `main` fails to start against `ponder_v4`.
  Redeploy v4 only from a pinned pre-#358 commit (tag it, e.g.
  `indexer-v4-final`, before merging).
- `indexer-v5` must deploy from a commit that also carries the mainnet
  Surface v2 deploy record (#357: `contracts/deployments.mainnet.json`
  `surfaceFactoryV2`/`saleFactoryV2`/`launcherV2`/`factoryDeployBlock`
  and the `@pin/addresses` constants). Without it the v2 sources are
  omitted on mainnet and Form of Solitude is not indexed.
- Web must already understand v2 rows before the flip (#360, safe on
  `ponder_v4` through column-existence gating).

## Replay

1. Create Railway service `indexer-v5` in `pnd-v2` with
   `DATABASE_SCHEMA=ponder_v5` (the schema Ponder writes; copy the rest of
   `indexer-v4`'s variables) and `railway up --service indexer-v5` from
   the chosen commit. Consider the primary RPC only for the genesis
   replay: drpc's free tier rejects `eth_getLogs` ranges over 10,000
   blocks.
2. Wait for `select value->>'is_ready' from ponder_v5._ponder_meta where key = 'app'`
   to read `1`. Process health alone is not readiness.

## Parity gate

Run the read-only gate (it opens a read-only session and only SELECTs):

```sh
DATABASE_URL=<maglev url> pnpm indexer:parity --from ponder_v4 --to ponder_v5 \
  --spot 0x4490f1dadefa3234961404f5cc58056296eb4a89 \
  --rpc-url https://gateway.tenderly.co/public/mainnet
```

It exits 1 on any FAIL. What it checks:

- `ponder_v5` is ready; both mainnet checkpoints (block, age).
- Every `ponder_v4` table and column exists in `ponder_v5`. The only
  reviewed drop is `collections.royalty_locked`. New tables
  (`token_ownership`, `collection_creators`) and columns are reported as
  additive.
- Row counts table by table: `ponder_v5` must not have fewer rows.
  Expect more in `collections`, `minters` and `collection_*` (v2 rows).
  The Catalog tables only WARN on a shrink (unregister deletes rows).
- v1 parity: each `collection_*` table restricted to
  `protocol_version = 1` collections must match `ponder_v4`.
- `ponder_sync.factory_addresses` per factory stream against the
  matching source rows in `ponder_v5`: PND V1/V2 houses (`pnd_houses` by
  `version`), Surface v1 collections (`topic2`) and minters (`offset0`),
  Surface v2 collections and sales (`topic2` of each CloneFactory). A
  missing child is a FAIL: its per-clone events were never indexed, so
  replay again rather than repairing `factory_addresses` by hand. Extra
  watched children are expected on the minter and sale streams (the v1
  `offset0` stream watches `address(0)`, the sale stream watches sales
  bound to collections the token factory never made) and WARN on the
  collection streams.
- Which schema `public.known_artists` reads (see Cutover).

`--rpc-url` needs archive `eth_getLogs`: publicnode refuses it, Tenderly's
public gateway serves it. Without `--rpc-url` the Sold comparison below
is printed as INFO and must be done by hand.

Why a gate and not draft PR #300's `indexer_live` alias + switch: web's
build guard and `/api/health/indexer` read `<schema>._ponder_checkpoint`,
which the alias views do not carry; `SELECT *` views freeze their column
list at creation, which #360's column-existence gating would then read;
and moving web and worker onto an alias in the same window as this
cutover stacks two risky changes. `INDEXER_SCHEMA` stays the single
source (`apps/web/src/lib/indexer-schema.ts`); the flip stays manual
behind the gate.

## Form of Solitude spot check

The `--spot` run above covers it; confirm each line is PASS:

- `ponder_v5.collections` has `0x4490f1dadefa3234961404f5cc58056296eb4a89`
  with `protocol_version = 2`, `owner_confirmed = true` (the owner sent
  the launch tx) and `launcher` = `launcherV2` from
  `contracts/deployments.mainnet.json`.
- Its FixedPriceSale `0x86a1de6c3136dc5a421ac8372ec9e05e1c533dff` is in
  `ponder_v5.minters`.
- `collection_sales` rows for that sale equal its onchain `Sold` event
  count. By hand, if needed:

  ```sql
  select count(*) from ponder_v5.collection_sales
  where minter = '0x86a1de6c3136dc5a421ac8372ec9e05e1c533dff';
  ```

  against `cast logs --address 0x86a1de6c3136dc5a421ac8372ec9e05e1c533dff
  'Sold(address,address,address,uint256,uint256,uint256)'
  --from-block 26325534 --rpc-url <archive rpc> | grep -c transactionHash`.
- Spot owners: for a few rows of
  `select token_id, owner from ponder_v5.collection_tokens
  where collection = '0x4490f1dadefa3234961404f5cc58056296eb4a89' order by token_id`,
  `cast call 0x4490f1dadefa3234961404f5cc58056296eb4a89 'ownerOf(uint256)(address)' <id>`
  must return the same owner.

## Cutover

1. Flip `INDEXER_SCHEMA=ponder_v5` in Netlify's **production** context
   and redeploy web. The build guard (`scripts/check-indexer-schema.mjs`)
   fails the build if the schema is missing or stale.
2. Flip `INDEXER_SCHEMA=ponder_v5` on the Railway **worker** and
   redeploy it. Its scanners and drift check read `INDEXER_SCHEMA`
   tables, and its code default is stale.
3. Rebuild `known_artists` for the new schema. The view bakes in the
   ponder schema it was created against, so it keeps reading `ponder_v4`
   after the flip. Open PR #368 adds `pnd_rebuild_known_artists(schema)`
   and has the worker call it on startup for its `INDEXER_SCHEMA`, so
   once #368 is deployed the worker redeploy in step 2 does this. If its
   migration is applied but the worker change is not, run it by hand:

   ```sql
   SELECT pnd_rebuild_known_artists('ponder_v5');
   ```

   Either way, confirm with `select pg_get_viewdef('known_artists')` or
   the gate's `known_artists` line (re-run the gate after the flip).
4. Readiness check below.

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

After the Cutover steps, confirm on the live site:

```
GET https://pnd.fyi/api/health/indexer
```

The response's configured schema must read `ponder_v5` and its
freshness timestamp must be recent (the build guard,
`scripts/check-indexer-schema.mjs`, already fails the build if the
schema does not exist or has gone stale, but confirm on the deployed
site rather than trusting the env var took effect from the Netlify UI
alone, per the ponder_v1 incident in `AGENTS.md`).

On the worker, confirm the next `ponder-drift-check` iteration in
`worker_iterations` is `ok = true` against `ponder_v5`.

## Rollback

Flip `INDEXER_SCHEMA` back to `ponder_v4` on Netlify production and the
worker, redeploy both, and rebuild `known_artists` for `ponder_v4`.
`indexer-v4` keeps writing `ponder_v4` throughout; if it has to be
redeployed, deploy it from the pinned pre-#358 commit, never from
`main` (see Before you start).
