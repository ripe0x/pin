# PND Collections e2e (browser-driven)

Headless end-to-end verification of the studio create-collection flow + mint
UI: a real Chromium browser drives the actual Next app against a real Anvil
mainnet fork, and the spec asserts the resulting onchain state. Modeled on
the `permanent-collection` UI debug system (Anvil signs server-side; drive
the real browser, not a mocked wagmi config).

The spec is `collections.spec.ts`. The previous `editions.spec.ts` drove
`/editions/new` (`CreateEditionForm`), which no longer exists — Editions was
retired in favor of Collections (`/collections`), and `/editions/*` routes
now just redirect. It has been replaced (not renamed in place — the old file
is gone) by `collections.spec.ts`, which drives the actual Collections
creation flow: the studio wizard at
`apps/web/src/app/studio/[address]/create/` (component tree under
`src/components/studio/create/`).

## Run

```bash
pnpm --filter @pin/web test:e2e
# first time only (Chromium):
pnpm --filter @pin/web test:e2e:install

# just this spec:
pnpm --filter @pin/web exec playwright test tests/e2e/collections.spec.ts
```

Prerequisites: Foundry (`anvil`, `forge`, `cast`) on `~/.foundry/bin`, and
network access for the mainnet fork (defaults to free publicnode; override
with `E2E_FORK_RPC`).

## How it works

`fixtures/globalSetup.ts` brings the stack up once:

1. **Anvil mainnet fork** on a free port, chain id **31339** (the id
   `wagmi.ts` registers for `forkChain`), with `--auto-impersonate`. Forking
   mainnet means **Multicall3** is present at its real mainnet address, which
   the collections server reads (`getCollection` et al) depend on.
2. Deploys the Surface core to the fork
   (`forge script script/DeploySurfaceSystem.s.sol`): it reuses the forked
   mainnet Catalog, deploys the sequential, pooled, and fixed-price-minter
   implementations, and deploys a paused factory. The fixture then deploys
   ownerless `RenderAssets` + `DefaultRenderer` reference modules, opens the
   fork-local factory, and exports the addresses to the test app. The factory
   has no default renderer, matching mainnet; the spec supplies the renderer
   explicitly through the supported Renderer-native preset.
3. Starts `next dev` with the fork env + `NEXT_PUBLIC_DEV_IMPERSONATE`, so
   PND's **wagmi mock connector auto-connects** as the impersonated account.
   No wallet, no modal, no private key in the browser — Anvil signs each tx
   server-side because the account is auto-impersonated. The studio pages
   gate on `OwnerGate` (connected wallet must match the studio's `[address]`
   route param), so specs visit `/studio/<impersonated address, lowercase>/create`
   — the checksummed form redirects to the studio dashboard, it does not
   404, so a spec that forgets to lowercase silently lands somewhere else.

`fixtures/test.ts` exposes the stack state (RPC URL, factory, renderer,
RenderAssets, impersonated account) to specs. `fixtures/globalTeardown.ts`
stops both processes.

## What `collections.spec.ts` verifies

One **Renderer-native full create → deploy → mint → verify** test. It first
asserts that Edition and Generative remain disabled while the factory has no
shared renderer, then supplies the fork-local reference renderer and deploys a
capped, 0.01 ETH collection. It verifies the collection page, mints through
`MintCollectionCTA`, polls the fresh onchain count, and checks the token's
derived mint order plus full seed. Pure renderer/parity assembly remains
covered by the fast unit tests under `src/lib/collection-render/`.

Traces/screenshots land under `tests/e2e/test-results/` on failure (gitignored).

## Notes

- Single worker: specs share one fork and mutate chain state.
- The mock-connector path is PND-native (see `src/lib/wagmi.ts`). For higher
  connect-flow fidelity you could swap in an injected EIP-1193 provider via
  `page.addInitScript` (as permanent-collection does); not needed here since
  the goal is to verify the write path, not the RainbowKit modal.
- Selectors are role/label based throughout (`getByRole`, `getByLabel`,
  `getByText`) — every wizard input already has a properly associated
  `<label htmlFor>`/`id` pair, so no test ids were added.
