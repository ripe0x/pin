# PND Collections e2e (browser-driven)

Headless end-to-end verification of the release + mint UI: a real Chromium
browser drives the actual Next app against a real Anvil mainnet fork, and the
spec asserts the resulting onchain state. Modeled on the
`permanent-collection` UI debug system (Anvil signs server-side; drive the
real browser, not a mocked wagmi config).

**Status: `editions.spec.ts` is stale and currently broken.** It drives
`/editions/new` (`CreateEditionForm`), which no longer exists — Editions was
retired in favor of Collections (`/collections`), and `/editions/*` routes
now just redirect. `fixtures/globalSetup.ts` has been updated to deploy the
Collections system (`DeployCollectionSystem.s.sol`), but the spec itself
still exercises the old create-then-mint UI flow and needs to be rewritten
against the Collections creation flow (owned by the studio work,
`apps/web/src/app/studio/[address]/create/`) once that lands. Rename to
`collections.spec.ts` at that point.

## Run

```bash
pnpm --filter @pin/web test:e2e
# first time only (Chromium):
pnpm --filter @pin/web test:e2e:install
```

Prerequisites: Foundry (`anvil`, `forge`, `cast`) on `~/.foundry/bin`, and
network access for the mainnet fork (defaults to free publicnode; override
with `E2E_FORK_RPC`).

## How it works

`fixtures/globalSetup.ts` brings the stack up once:

1. **Anvil mainnet fork** on a free port, chain id **31339** (the id
   `wagmi.ts` registers for `forkChain`), with `--auto-impersonate`. Forking
   mainnet means **Multicall3** is present, which the editions server reads
   (`getEditionProject`) depend on.
2. Deploys the editions system (`forge script DeployEditions`) and parses the
   factory address.
3. Starts `next dev` with the fork env + `NEXT_PUBLIC_DEV_IMPERSONATE`, so
   PND's **wagmi mock connector auto-connects** as the impersonated account.
   No wallet, no modal, no private key in the browser — Anvil signs each tx
   server-side because the account is auto-impersonated.

`fixtures/test.ts` exposes the stack state (RPC URL, factory, account) to
specs. `fixtures/globalTeardown.ts` stops both processes.

## What `editions.spec.ts` verifies

The real UI flow, click by click: deploy a project → publish a gas-only
release → mint it. Then it reads the fork directly and asserts
`totalSupply == 1`, `ownerOf(1) == the wallet`, and the Mint Mark
(`releaseId 0`, `indexInRelease 0`, `isFirst == true`). Screenshots land in
`tests/e2e/screenshots/` (gitignored); traces/reports on failure.

## Notes

- Single worker: specs share one fork and mutate chain state.
- The mock-connector path is PND-native (see `src/lib/wagmi.ts`). For higher
  connect-flow fidelity you could swap in an injected EIP-1193 provider via
  `page.addInitScript` (as permanent-collection does); not needed here since
  the goal is to verify the write path, not the RainbowKit modal.
