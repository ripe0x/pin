/**
 * Playwright config for the PND Editions e2e harness.
 *
 * One Anvil mainnet fork + one Next dev server, shared across specs (single
 * worker — specs mutate shared chain state). globalSetup brings the stack up;
 * globalTeardown stops it. Chromium only: the flow is wallet/browser-API
 * heavy and we verify behaviour in one engine.
 */
import { defineConfig, devices } from "@playwright/test"

const APP_PORT = Number(process.env.E2E_APP_PORT ?? "3100")

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./tests/e2e/fixtures/globalSetup.ts",
  globalTeardown: "./tests/e2e/fixtures/globalTeardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Cold Anvil fork + deploy + first turbopack route compile + 3 sequential
  // txs with receipts needs headroom without hiding genuine hangs.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
