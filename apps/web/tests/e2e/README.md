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
   mainnet means **Multicall3**, **ScriptyStorageV2**, and **EthFS v2** are
   all present at their real mainnet addresses, which the collections server
   reads (`getCollection` et al) and the GENERATIVE preset's dependency
   picker depend on.
2. Deploys the Sovereign Collection system
   (`forge script DeployCollectionSystem.s.sol`: Attribution, DefaultRenderer,
   GenerativeRenderer, the Collection implementation, and the
   factory that clones it) and parses the **factory** and
   **GenerativeRenderer** addresses out of the script's console output.
   Both are exported as `NEXT_PUBLIC_*` env vars to the dev server — as of
   this writing neither has a real mainnet address in `@pin/addresses`
   (`SOVEREIGN_COLLECTION_FACTORY`/`GENERATIVE_RENDERER` are still the zero
   address there), so the env override is the *only* way either resolves.
   Skipping the `NEXT_PUBLIC_GENERATIVE_RENDERER` wiring silently breaks the
   GENERATIVE preset's deploy step (`DeployStep.tsx` blocks with "No
   GenerativeRenderer is configured for this network").
3. Starts `next dev` with the fork env + `NEXT_PUBLIC_DEV_IMPERSONATE`, so
   PND's **wagmi mock connector auto-connects** as the impersonated account.
   No wallet, no modal, no private key in the browser — Anvil signs each tx
   server-side because the account is auto-impersonated. The studio pages
   gate on `OwnerGate` (connected wallet must match the studio's `[address]`
   route param), so specs visit `/studio/<impersonated address, lowercase>/create`
   — the checksummed form redirects to the studio dashboard, it does not
   404, so a spec that forgets to lowercase silently lands somewhere else.

`fixtures/test.ts` exposes the stack state (RPC URL, factory,
generativeRenderer, impersonated account) to specs. `fixtures/globalTeardown.ts`
stops both processes.

## What `collections.spec.ts` verifies

Two serial tests (`test.describe.configure({ mode: "serial" })`), sharing the
one fork:

1. **EDITION preset, full create → deploy → mint → verify.** Click through
   the wizard (preset → configure → deploy) for a capped, 0.01 ETH Edition,
   assert the deploy success screen's "View collection" link, then read the
   collection page (name, Open status, price) and mint one token through
   `MintCollectionCTA`. Polls the minted count (via `expect.poll` + a fresh
   page reload, not a fixed sleep) until the fork's next block has landed,
   then visits the token page and checks the Mint Mark (`#1 in the
   collection`, "First mint of the collection") and the onchain seed hex.
2. **GENERATIVE preset, config → PREVIEW only.** Deliberately does not upload
   the script (chunked `ScriptyStorageV2` writes) or deploy — test 1 already
   covers that write path, and upload+deploy chains enough txs to add ~2
   minutes for no new coverage. Fills in a tiny p5.js sketch that reads
   `tokenData.hash`, checks the p5 dependency, and asserts the Preview step
   renders 4 `iframe[title^="Test seed "]` elements whose `srcdoc` is
   >100KB — proof the parity builder (`lib/collection-render/build.ts`)
   actually resolved the forked EthFS dependency bytes into the assembled
   document, not just that no error banner appeared.

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
