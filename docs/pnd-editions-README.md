# PND Editions

> Entry point for the PND Editions feature. Start here, then follow the
> links. This doc is the map: what it is, where every piece lives, how to
> develop / test / deploy, and what is verified vs deploy-gated.

## What it is

A mainnet-only, artist-owned **ERC721A** edition protocol. A release begins
as shared artwork under shared mint conditions, but every minted token keeps
its own identity, so it can carry provenance now (**Mint Marks**) and point
somewhere later (**Token Path**). The only money that moves is the price the
artist set, split exactly how the artist chose between the artist and the
**mint surface**. There is no protocol fee.

Three onchain layers, each readable by any interface (not just PND):

1. **Editions** — one `PNDEditions` (ERC721A) contract per project, holding
   one or more releases. Honest fixed price with an out-of-price Surface
   Share, per-batch Mint Marks, EIP-2981, a swappable renderer, and pre/post
   mint hooks. Opt-in upgradeability (immutable clone vs UUPS).
2. **Release Graph** — typed, append-only edges between releases
   (`BelongsTo`, `StudyOf`, `PhaseOf`, `Continues`, `Source`, `Access`),
   addressable across contracts and artists.
3. **Token Path** — a per-token forward pointer (continuation / migration /
   claim / reveal / burn). v1 ships the pointer layer only.

## Status

| Area | State |
|---|---|
| Contracts + tests | Done. 42 Foundry tests pass (incl. 256-run fuzz on the split). |
| Web release + mint UI | Done. Typechecks, production build green, **e2e passes in a real browser**. |
| Local dev + e2e harness | Done. `pnpm dev:editions` and `pnpm --filter @pin/web test:e2e`. |
| Mainnet deploy | Not done. No factory address yet. |
| Indexer/worker discovery | Deploy-gated. ABI is ready; wiring documented in the runbook. |

## Documentation index

- **[pnd-editions.md](./pnd-editions.md)** — the design plan: what we learned
  from Zora and Mint Protocol, what to copy/adapt/avoid, the architecture,
  v1 scope, risks, open questions, build sequence. The "why".
- **[pnd-editions-spec.md](./pnd-editions-spec.md)** — Phase 0 onchain
  interface spec: `Ref` URN format, `IPNDEditions`, the Mint Mark batch
  model, renderer, hooks, graph, path, factory. The "what the contract
  exposes".
- **[pnd-editions-integration.md](./pnd-editions-integration.md)** — the
  deploy + indexing runbook: deploy steps, and the exact post-deploy Ponder
  discovery + worker scan wiring (deploy-gated).
- **[../apps/web/tests/e2e/README.md](../apps/web/tests/e2e/README.md)** —
  the browser-driven e2e harness.

## Where everything lives

### Contracts (`contracts/`)

```
src/editions/
  PNDEditionsTypes.sol        Shared enums + structs (Ref, ReleaseConfig,
                              MintBatch, MintMark, Edge, Path, ProjectMode).
  PNDEditions.sol             The per-project ERC721A contract: releases,
                              mint + out-of-price Surface Share, per-batch
                              Mint Marks (binary-search resolved), Release
                              Graph, Token Path, renderer/hook resolution,
                              EIP-2981, UUPS opt-in + seal.
  PNDEditionsFactory.sol      Per-project deploy (ImmutableClone EIP-1167 or
                              Upgradeable ERC1967). Emits ProjectCreated.
  PNDDefaultRenderer.sol      Built-in renderer: base64 onchain JSON with the
                              Mint Mark as provenance attributes.
  interfaces/
    IPNDEditions.sol          IPNDEditions + IPNDMintMarks + IPNDReleaseGraph
                              + IPNDTokenPath + all events.
    IPNDRenderer.sol          IPNDRenderer + IPNDEditionsView (renderer reads).
    IPNDMintHook.sol          IPNDMintHook (before/after, magic-value gated).
script/DeployEditions.s.sol   Deploy renderer + impl + factory, asserts wiring.
test/editions/                42 tests: PNDEditions.t.sol (core + fuzz),
                              PNDEditionsHooks.t.sol, PNDEditionsUpgrade.t.sol,
                              PNDEditionsBase.sol, EditionsMocks.sol.
foundry.toml                  Added the erc721a-upgradeable remapping.
```

### ABIs + addresses (`packages/`, `scripts/`)

```
packages/abi/src/pndEditions.ts, pndEditionsFactory.ts   Extracted ABIs.
packages/abi/src/index.ts                                Re-exports them.
packages/addresses/src/index.ts                          PND_EDITIONS_FACTORY
                                                         (mainnet TBD).
scripts/emit-editions-abi.mjs                            Regenerate ABIs from
                                                         forge artifacts.
```

### Web (`apps/web/`)

```
src/lib/pnd-editions.ts        Client-safe: enums/labels, ABI-return decoders,
                               honest-pricing math, surface-split, chain id,
                               URN + evm.now helpers.
src/lib/editions-onchain.ts    Server-only cached, multicalled reads (project,
                               release(s), edges, token view, recent projects).
src/components/editions/
  MintReleaseCTA.tsx           Live mint CTA: price, visible split, Mint Mark
                               preview, supply, countdown, full tx lifecycle.
  CreateReleaseFlow.tsx        Deploy project + configure release, event-parsed.
  MintMarkCard.tsx             Provenance display (not rarity).
  ReleaseGraphView.tsx         Outgoing edges, onchain-sourced.
src/app/editions/
  page.tsx                     Landing + recent projects.
  new/page.tsx                 Create flow.
  [project]/page.tsx           Project + releases.
  [project]/[releaseId]/page.tsx        Release detail + mint.
  [project]/token/[tokenId]/page.tsx    Token + Mint Mark + Token Path.
src/components/Navbar.tsx      "Release an edition" in the For-artists menu.
src/components/tx/tx-ui.tsx    PREFERRED_CHAIN points at the configured
                               forkChain so fork-mode tx checks pass.
```

### Local dev + tests

```
scripts/dev-editions.sh        One command: fork + deploy + dev server.
package.json                   "dev:editions" script.
apps/web/playwright.config.ts  Playwright config.
apps/web/tests/e2e/            globalSetup/teardown, fixture, editions.spec.ts.
apps/web/package.json          "test:e2e" / "test:e2e:install" scripts.
```

### Indexer (`apps/indexer/`)

```
abis/PNDEditionsFactory.ts     Discovery ABI, ready to wire post-deploy.
```

## Develop and test locally

### Click through it yourself

```bash
pnpm dev:editions
```

Finds a free port, starts an Anvil mainnet fork (chain id 31339,
`--auto-impersonate`), deploys the editions system, writes
`apps/web/.env.development.local`, and starts the web dev server with the
wallet auto-connected (no real wallet needed). Open
`http://localhost:3000/editions/new`. Ctrl+C stops Anvil; delete
`apps/web/.env.development.local` to restore your normal env. Overridable:
`FORK_RPC`, `IMPERSONATE`, `WEB_PORT`.

### Automated browser e2e

```bash
pnpm --filter @pin/web test:e2e          # run
pnpm --filter @pin/web test:e2e:install  # first time: Chromium
```

Drives the real UI (deploy project, publish release, mint) against a real
fork and asserts onchain state. See
[apps/web/tests/e2e/README.md](../apps/web/tests/e2e/README.md).

### Contracts

```bash
cd contracts && forge test --match-path "test/editions/*" -vv
# after a contract change, refresh the frontend ABIs:
node scripts/emit-editions-abi.mjs
```

## Pricing model (honest money)

The collector pays exactly `price * quantity`. Nothing is added on top, and
PND takes no fee. If the artist set a Surface Share (bps), that share comes
**out of** the price and goes to whatever surface facilitated the mint
(PND's address on PND, the artist's address on a self-hosted page,
`address(0)` folds it back to the artist). A 0 ETH price is labelled "Gas
only", never "free".

## Deploy

```bash
cd contracts
forge script script/DeployEditions.s.sol \
  --rpc-url $MAINNET_RPC_URL --private-key $DEPLOYER_PK \
  --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY
```

Then paste the factory address into `packages/addresses/src/index.ts` and the
web app is live (it reads the project's own contracts directly). Postgres-
backed discovery (artist pages / feeds) is the deploy-gated work in the
[integration runbook](./pnd-editions-integration.md).

## Verification status

- **Contracts:** 42 Foundry tests pass, including a 256-run fuzz on the
  payment split. Covers economics, caps, windows, interleaved-release Mint
  Marks, first/final, graph, path, renderer override, hook gating/recording,
  immutable-vs-upgradeable + seal.
- **Web:** typecheck clean; production build green (all five `/editions`
  routes compile).
- **End to end:** the create + mint flow passes in a real Chromium browser
  against a real Anvil fork; on-chain assertions confirm ownership, supply,
  and the Mint Mark.
- **Live fork round-trip:** deploy → createProject → createRelease → mint →
  reads, plus Release Graph + Token Path writes, exercised via `cast`.

Not verifiable without a mainnet deploy: the production deploy itself and a
real-wallet (non-impersonated) browser signature, which is inherent.

## Extending it

- New contract behavior: edit `contracts/src/editions/`, add tests under
  `contracts/test/editions/`, run `forge test`, then
  `node scripts/emit-editions-abi.mjs` to refresh the frontend ABIs.
- The architecture deliberately keeps discovery (Ponder) vs token-scanning
  (worker) split per `AGENTS.md`. PND Editions discovery is a fixed factory,
  so it belongs in Ponder once deployed; per-release indexing belongs in the
  worker. See the integration runbook.
