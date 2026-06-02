# PND Editions — deployment + indexing runbook

> What is live now, and the exact steps to finish the deploy-gated
> pieces. The contracts (`contracts/src/editions`), the web release/mint
> experience (`apps/web/src/app/editions`, `components/editions`), and
> the ABIs/addresses are committed. The indexer/worker discovery layer is
> intentionally NOT wired yet because Ponder needs the factory's real
> deployed address + start block — wiring a zero address would break the
> running indexer.

## What works today (no indexer required)

The release, mint, project, and token pages read the project's OWN
contracts directly via cached, multicalled onchain reads
(`apps/web/src/lib/editions-onchain.ts`). The landing's "recent projects"
reads the factory's `allProjects` (cached 1h). So the full
release-and-mint experience is live the moment the factory is deployed
and its address is configured. Pre-deploy, `pndEditionsFactory()` returns
null and the surfaces degrade gracefully (the create flow shows "no
factory configured", the landing shows just the create CTA).

## Step 1 — deploy (mainnet)

```bash
cd contracts
forge script script/DeployEditions.s.sol \
  --rpc-url $MAINNET_RPC_URL --private-key $DEPLOYER_PK \
  --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY
```

This deploys `PNDDefaultRenderer`, the `PNDEditions` implementation, and
`PNDEditionsFactory`. Note the factory address and its deploy block.

## Step 2 — configure the address

- `packages/addresses/src/index.ts`: set
  `PND_EDITIONS_FACTORY[MAINNET_CHAIN_ID]` to the deployed factory.
- Optionally set `NEXT_PUBLIC_PND_SURFACE_ADDRESS` (PND treasury) so PND
  collects the artist-allowed Surface Share on mints that happen on PND.
  Leave unset and PND takes nothing.
- Re-run `node scripts/emit-editions-abi.mjs` only if the contracts
  changed since the last emit.

At this point the web app is fully live. Steps 3–5 add Postgres-backed
discovery so artist pages / feeds can surface PND Editions without
onchain reads.

## Step 3 — Ponder discovery (factory → projects table)

The ABI is ready at `apps/indexer/abis/PNDEditionsFactory.ts`. Add:

**`apps/indexer/ponder.schema.ts`** — a discovery table (mirrors
`mintCreators`):

```ts
export const pndEditionsProjects = onchainTable(
  "pnd_editions_projects",
  (t) => ({
    contract: t.hex().primaryKey(), // the project
    owner: t.hex().notNull(),       // the artist
    mode: t.integer().notNull(),    // 0 immutable clone, 1 upgradeable
    firstSeenBlock: t.bigint().notNull(),
    firstSeenTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ ownerIdx: index().on(table.owner) }),
)
```

**`apps/indexer/ponder.config.ts`** — import the ABI and register the
factory with its real address + block:

```ts
import { pndEditionsFactoryAbi } from "./abis/PNDEditionsFactory"
const PND_EDITIONS_FACTORY_ADDRESS = "0x…" as const   // from Step 1
const PND_EDITIONS_FACTORY_DEPLOY_BLOCK = 0            // from Step 1
// inside contracts: { ... }
PNDEditionsFactory: {
  chain: "mainnet",
  abi: pndEditionsFactoryAbi,
  address: PND_EDITIONS_FACTORY_ADDRESS,
  startBlock: PND_EDITIONS_FACTORY_DEPLOY_BLOCK,
},
```

**`apps/indexer/src/PNDEditions.ts`** — handler (mirrors `Mint.ts`):

```ts
import { ponder } from "ponder:registry"
import { pndEditionsProjects } from "ponder:schema"

ponder.on("PNDEditionsFactory:ProjectCreated", async ({ event, context }) => {
  const { owner, project, mode } = event.args
  await context.db
    .insert(pndEditionsProjects)
    .values({
      contract: project,
      owner,
      mode: Number(mode),
      firstSeenBlock: event.block.number,
      firstSeenTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})
```

**`known_artists` view** — UNION `pnd_editions_projects.owner` in so PND
deployers auto-promote into the scan ceiling (same as
`mint_creators.address`). This lives in the worker's
`seed-known-artists` SQL.

Then `pnpm --filter @pin/indexer codegen` regenerates the `ponder:*`
virtual modules and the handler typechecks.

## Step 4 — worker scan (releases → Postgres)

Decision to make first (Open Question for the gallery): index at the
**release** level, not the token level. A PND release is many ERC721
tokens sharing artwork; one gallery row per release (like Mint's
one-row-per-1155-id) reads cleanly, whereas one row per copy would flood
the gallery with identical thumbnails.

Add `apps/worker/src/tasks/scan-pnd-editions.ts`, gated on
`known_artists` joined to `pnd_editions_projects`. For each project, read
`totalReleases()` and each `release(i)` (multicall) and upsert one
discovery row per release into a new `public.pnd_editions_releases` table
(or `artist_tokens` with `platform='pnd-editions'` and `token_id =
releaseId` if you want it in the existing gallery query — but that
overloads `token_id`, so a dedicated table is cleaner). Register the task
in `apps/worker/src/scheduler.ts` with `dependsOnPonder: true`.

Note: do NOT reuse `scanArtistTokensViaTransferFromZero` as-is — it
filters `to: artist`, but PND collectors mint to themselves. Read
releases (or the `Minted` event), not per-token transfers.

## Step 5 — wire web discovery to Postgres

Add a `reads.ts` function (Postgres SELECT on `pnd_editions_projects` /
`pnd_editions_releases`) and have the `/editions` landing and the artist
gallery prefer it, falling back to the cached onchain read. This removes
the landing's onchain factory read once the indexer is caught up.

## Migrations

Any new `public` table (Step 4) is a `db/migrations/0NN_*.sql` applied by
`pnpm db:migrate`. The Ponder tables (Step 3) are managed by Ponder via
`ponder.schema.ts`, not `db/migrations`. Reconcile the flagged
`016`/`017` migration drift (see AGENTS.md) before adding new migrations.
