# Collection System reference

The API-style reference for every PND Collection System contract, rendered on the
site at `/docs`. The markdown tree here is the canonical source; the site serves a
pre-rendered copy of the same content.

## Layout

| Path | What it is |
| --- | --- |
| `introduction/`, `concepts/`, `contracts/`, `guides/`, `offchain/`, `reference/` | **Generated output.** Don't edit these files directly |
| `_prose/` | Hand-authored per-contract prose supplements (see [`_prose/SPEC.md`](_prose/SPEC.md)) |
| `_pages/` | Hand-written pages (overview, concepts, guides, off-chain docs) |
| `_assets/` | SVG diagrams referenced by hand pages (inlined on the site) |

## Regenerating

```bash
pnpm generate:docs
```

`scripts/generate-docs.ts` merges the checked-in ABIs (`@pin/abi`, i.e.
`packages/abi/src/*.ts`) and `contracts/deployments.mainnet.json` with the prose
in `_prose/` and `_pages/`, then emits:

- the final markdown pages here
- `apps/web/src/lib/docs/manifest.json` + `content.json` (sidebar + pre-rendered
  HTML the site imports)
- `apps/web/public/abis/*.json`, `apps/web/public/protocol-manifest.json`,
  `apps/web/public/llms.txt`, `apps/web/public/docs-search-index.json`

The generator is strict: every ABI function, event, and error must have a prose
block, every state-changing function must declare its access model, and prose
naming unknown ABI items fails the run. Signatures, event topics, and error lists
are derived from the ABIs and can't drift from the contracts.

## Refreshing the ABIs

If the collection contracts change, rebuild and re-extract the ABIs first, then
regenerate:

```bash
cd contracts && forge build
node scripts/emit-collection-abi.mjs   # or: pnpm emit:collection-abi
pnpm generate:docs                     # the validator points at any new prose gaps
```

## Pre-deploy

The Collection System is pre-deploy. `contracts/deployments.mainnet.json` holds
the shared-singleton addresses; while they're empty, pages show a "pending deploy"
note and `{{addr:*}}` tokens render as `<KEY_ADDRESS>` placeholders. Fill the file
at launch and re-run `pnpm generate:docs` to light up real addresses and cast
examples. Each artist collection is a separate EIP-1167 clone, so it never appears
in that file.
