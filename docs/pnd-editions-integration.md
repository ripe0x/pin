# PND Editions — deployment + indexing runbook

> **SUPERSEDED (2026-07-06).** The Editions contract was reworked into the
> Collection system (OZ ERC721 core, four slots, id modes); see
> docs/pnd-collection-system.md and docs/pnd-collection-contracts-plan.md.
> This document describes the pre-rework ERC721A design; payment-split,
> hook, and graph concepts carry over, token-layer specifics do not.
> Contracts now live in contracts/src/collection/ (src/editions/ was
> removed).

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

## Step 3 — Ponder discovery (factory → editions table)

The ABI is ready at `apps/indexer/abis/PNDEditionsFactory.ts`. Each edition
is one contract, so discovery is one row per edition. Add:

**`apps/indexer/ponder.schema.ts`** — a discovery table (mirrors
`mintCreators`):

```ts
export const pndEditions = onchainTable(
  "pnd_editions",
  (t) => ({
    contract: t.hex().primaryKey(), // the edition contract
    owner: t.hex().notNull(),       // the artist
    firstSeenBlock: t.bigint().notNull(),
    firstSeenTime: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ ownerIdx: index().on(table.owner) }),
)
```

**`apps/indexer/ponder.config.ts`** — import the ABI and register the
factory with its real address + block (from Step 1):

```ts
import { pndEditionsFactoryAbi } from "./abis/PNDEditionsFactory"
const PND_EDITIONS_FACTORY_ADDRESS = "0x…" as const
const PND_EDITIONS_FACTORY_DEPLOY_BLOCK = 0
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
import { pndEditions } from "ponder:schema"

ponder.on("PNDEditionsFactory:EditionCreated", async ({ event, context }) => {
  const { owner, edition } = event.args
  await context.db
    .insert(pndEditions)
    .values({
      contract: edition,
      owner,
      firstSeenBlock: event.block.number,
      firstSeenTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})
```

**`known_artists` view** — do NOT blindly UNION `pnd_editions.owner` in.
`createEdition` is permissionless and takes `owner` as a caller-supplied
argument (see the security review, M5), so an attacker can deploy editions
naming arbitrary owners and, if `owner` auto-promotes, force the worker to scan
those addresses across every platform (a denial-of-wallet on RPC spend). Promote
into the scan ceiling only on a verified signal: the deploy `tx.origin`/sender
equals `owner`, or an explicit onchain claim by the owner, or a manual
allowlist. Indexing the `pnd_editions` row itself (for discovery) is fine; it is
the scan-ceiling expansion from an unauthenticated field that must be gated.

Then `pnpm --filter @pin/indexer codegen` regenerates the `ponder:*`
virtual modules and the handler typechecks.

## Step 4 — worker enrichment (editions → Postgres)

One contract == one edition, so the gallery unit is the edition (one row
each, no per-copy flood). Add `apps/worker/src/tasks/scan-pnd-editions.ts`,
gated on `known_artists` joined to `pnd_editions`. For each edition, read
`config()` (artwork, price, window, status) and `totalSupply()`
(multicalled), and upsert one row per edition into a dedicated
`public.pnd_editions_index` table (do NOT overload `artist_tokens.token_id`
— a dedicated table is cleaner). Register the task in
`apps/worker/src/scheduler.ts` with `dependsOnPonder: true`.

Note: for the gallery you index editions via `config()`, not per-token
transfers, so the `to: artist` filter in
`scanArtistTokensViaTransferFromZero` is irrelevant here. If you later want
per-token rows (e.g. a collector page), scan the `Minted` event (it carries
`firstTokenId` + `quantity`), since collectors mint to themselves.

## Step 5 — wire web discovery to Postgres

Add a `reads.ts` function (Postgres SELECT on `pnd_editions` /
`pnd_editions_index`) and have the `/editions` landing and the artist
gallery prefer it, falling back to the cached onchain read
(`getRecentEditions` / `getEdition`). This removes the landing's onchain
factory read once the indexer is caught up.

## Migrations

Any new `public` table (Step 4) is a `db/migrations/0NN_*.sql` applied by
`pnpm db:migrate`. The Ponder tables (Step 3) are managed by Ponder via
`ponder.schema.ts`, not `db/migrations`. Reconcile the flagged
`016`/`017` migration drift (see AGENTS.md) before adding new migrations.
