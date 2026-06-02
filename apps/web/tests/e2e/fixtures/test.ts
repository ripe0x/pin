/**
 * Per-test fixture: loads the shared stack state (anvil RPC, factory,
 * impersonated account) written by globalSetup. The wallet is provided by
 * PND's wagmi mock connector (auto-connected via NEXT_PUBLIC_DEV_IMPERSONATE),
 * so no provider injection is needed — the page loads already connected and
 * writes are signed server-side by Anvil's auto-impersonate.
 */
import { test as base, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { STATE_FILE, type GlobalState } from "./globalSetup"

function loadState(): GlobalState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as GlobalState
  } catch (e) {
    throw new Error(`e2e: state file missing — did globalSetup run? ${String(e)}`)
  }
}

export const e2eTest = base.extend<{ state: GlobalState }>({
  // eslint-disable-next-line no-empty-pattern
  state: async ({}, use) => {
    await use(loadState())
  },
})

export { expect }
export type { Page }
