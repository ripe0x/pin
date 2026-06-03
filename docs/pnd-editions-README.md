# PND Editions

> Entry point for the PND Editions feature. Start here, then follow the
> links. This doc is the map: what it is, where every piece lives, how to
> develop / test / deploy, and what is verified vs deploy-gated.

## What it is

A mainnet-only, artist-owned **ERC721A** edition protocol. **One contract is
one edition**: shared artwork under shared mint conditions, deployed in a
single transaction. Every minted token keeps its own identity, so it can
carry provenance now (**Mint Marks**) and point somewhere later (**Token
Path**). The collector pays exactly the price the artist set.

Three onchain layers, each readable by any interface (not just PND):

1. **Edition** — one `PNDEditions` (ERC721A) contract. Honest fixed price, a
   fixed built-in **Surface Share**, per-batch Mint Marks, EIP-2981, a
   swappable renderer, and pre/post mint hooks. Two mint entrypoints:
   `mint(quantity)` (the honest default; no surface, artist gets 100%) and
   `mintWithRewards(quantity, surface, hookData)` (credits a host the share).
   Proceeds accrue per-address (pull payments) and are claimed with
   `withdraw(account)`, so a bad recipient can never brick minting; the artist
   can repoint future proceeds with `setPayoutAddress`. Always deployed
   upgradeable (UUPS); the owner can `seal()` to renounce upgrades and
   `freezeMetadata()` to renounce renderer/artwork changes (independent
   one-way switches, both surfaced in the UI).
2. **Edition Graph** — typed, append-only edges from one edition to other
   nodes (`BelongsTo`, `StudyOf`, `PhaseOf`, `Continues`, `Source`, `Access`),
   addressable across contracts and artists.
3. **Token Path** — a per-token forward pointer (continuation / migration /
   claim / reveal / burn). v1 ships the pointer layer only.

## Pricing model (honest money)

The collector pays exactly `price * quantity`. There are two mint paths:

- **`mint(quantity)`** — the honest default. No surface, so the artist gets
  **100%**. This is what a direct mint does.
- **`mintWithRewards(quantity, surface, hookData)`** — credits a host a
  **fixed 10% Surface Share** out of the price. Mint **on PND** → PND's
  frontend passes PND's address → PND earns the 10%. Mint on the artist's
  **own self-hosted page** → they pass their own address → they keep 100%. A
  `surface` of `address(0)` folds the share back to the artist.

So the share is open (any caller can pass any surface), but the default path
gives the artist everything; PND earns only when a mint goes through PND with
its address as the surface, and any artist opts out by self-hosting. Gas-only
editions (price 0) share nothing. The rate is a fixed protocol constant
(`SURFACE_SHARE_BPS = 1000`), not artist-configurable. Proceeds are pull
payments: they accrue per-address and are claimed via `withdraw(account)`.

## Status

| Area | State |
|---|---|
| Contracts + tests | Done. 40 Foundry tests pass (incl. 256-run fuzz on the split). |
| Web create + mint UI | Done. Typechecks, production build green, **e2e passes in a real browser**. |
| Local dev + e2e harness | Done. `pnpm dev:editions` and `pnpm --filter @pin/web test:e2e`. |
| Mainnet deploy | Not done. No factory address yet. |
| Indexer/worker discovery | Deploy-gated. ABI is ready; wiring documented in the runbook. |

## Documentation index

- **[pnd-editions.md](./pnd-editions.md)** — the design plan: Zora + Mint
  Protocol lessons, architecture, risks, open questions. Historical; see its
  v2 banner for what changed.
- **[pnd-editions-spec.md](./pnd-editions-spec.md)** — the current onchain
  interface spec: `Ref` URN, `IPNDEditions`, the Mint Mark batch model,
  renderer, hooks, graph, path, factory. The "what the contract exposes".
- **[pnd-editions-integration.md](./pnd-editions-integration.md)** — deploy +
  post-deploy indexing runbook (deploy-gated).
- **[../apps/web/tests/e2e/README.md](../apps/web/tests/e2e/README.md)** — the
  browser-driven e2e harness.

## Where everything lives

### Contracts (`contracts/`)

```
src/editions/
  PNDEditionsTypes.sol        Shared enums + structs (Ref, EditionConfig,
                              MintBatch, MintMark, Edge, Path).
  PNDEditions.sol             The edition: ERC721A, mint + fixed Surface Share,
                              per-batch Mint Marks (binary-search resolved),
                              Edition Graph, Token Path, renderer/hook, EIP-2981,
                              UUPS + seal().
  PNDEditionsFactory.sol      Deploy + configure an edition (UUPS proxy) in one
                              tx. Emits EditionCreated.
  PNDDefaultRenderer.sol      Built-in renderer: base64 onchain JSON with the
                              Mint Mark as provenance attributes.
  interfaces/                 IPNDEditions, IPNDRenderer (+IPNDEditionsView),
                              IPNDMintHook.
script/DeployEditions.s.sol   Deploy renderer + impl + factory, asserts wiring.
test/editions/                40 tests (core + fuzz, hooks, upgrade).
```

### ABIs + addresses (`packages/`, `scripts/`)

```
packages/abi/src/pndEditions.ts, pndEditionsFactory.ts   Extracted ABIs.
packages/addresses/src/index.ts                          PND_EDITIONS_FACTORY.
scripts/emit-editions-abi.mjs                            Regenerate ABIs.
```

### Web (`apps/web/`)

```
src/lib/pnd-editions.ts        Client-safe: enums/labels, decoders, pricing math
                               (fixed split), chain id, URN + evm.now helpers.
src/lib/editions-onchain.ts    Server-only cached, multicalled reads.
src/components/editions/
  MintEditionCTA.tsx           Live mint CTA: price, visible split, Mint Mark
                               preview, supply, countdown, full tx lifecycle.
  CreateEditionForm.tsx        One-step: configure + deploy the edition.
  MintMarkCard.tsx             Provenance display (not rarity).
  EditionGraphView.tsx         Outgoing edges, onchain-sourced.
src/app/editions/
  page.tsx                     Landing + recent editions.
  new/page.tsx                 Create flow.
  [edition]/page.tsx           Edition detail + mint.
  [edition]/[tokenId]/page.tsx Token + Mint Mark + Token Path.
src/components/Navbar.tsx      "Release an edition" in the For-artists menu.
src/components/tx/tx-ui.tsx    PREFERRED_CHAIN points at forkChain in fork mode.
```

### Local dev + tests / indexer

```
scripts/dev-editions.sh        One command: fork + deploy + dev server (free port).
package.json                   "dev:editions" script.
apps/web/playwright.config.ts  Playwright config.
apps/web/tests/e2e/            globalSetup/teardown, fixture, editions.spec.ts.
apps/indexer/abis/PNDEditionsFactory.ts   Discovery ABI, ready to wire post-deploy.
```

## Develop and test locally

### Click through it yourself

```bash
pnpm dev:editions
```

Finds a free port, starts an Anvil mainnet fork (chain id 31339,
`--auto-impersonate`), deploys the editions system, writes
`apps/web/.env.development.local`, and starts the web dev server with the
wallet auto-connected (no extension needed). Open `/editions/new`. Ctrl+C
stops Anvil; delete `apps/web/.env.development.local` to restore your env.

### Automated browser e2e

```bash
pnpm --filter @pin/web test:e2e          # run
pnpm --filter @pin/web test:e2e:install  # first time: Chromium
```

Drives the real UI (deploy edition, mint) against a real fork and asserts
onchain state.

### Contracts

```bash
cd contracts && forge test --match-path "test/editions/*" -vv
node scripts/emit-editions-abi.mjs       # after a contract change
```

## Deploy

```bash
cd contracts
forge script script/DeployEditions.s.sol \
  --rpc-url $MAINNET_RPC_URL --private-key $DEPLOYER_PK \
  --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY
```

Then paste the factory address into `packages/addresses/src/index.ts`
(and set `NEXT_PUBLIC_PND_SURFACE_ADDRESS` to PND's treasury so PND collects
the surface share on PND-hosted mints). Postgres-backed discovery is the
deploy-gated work in the [integration runbook](./pnd-editions-integration.md).

## Verification status

- **Contracts:** 40 Foundry tests pass, including a 256-run fuzz on the fixed
  split and the self-host case (artist passes their own address as the
  surface and keeps 100%).
- **Web:** typecheck clean; production build green (all four `/editions`
  routes compile).
- **End to end:** the create + mint flow passes in a real Chromium browser
  against a real Anvil fork; on-chain assertions confirm ownership, supply,
  and the Mint Mark.
