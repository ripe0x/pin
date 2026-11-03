/**
 * Playwright config for the deployed-site smoke test (tests/smoke).
 *
 * Unlike playwright.config.ts (the Anvil-fork e2e harness), this starts
 * nothing: it points a browser at an already-deployed site, usually a
 * Netlify deploy preview, and checks that a handful of key pages render.
 *
 *   BASE_URL=https://deploy-preview-123--art-pin.netlify.app \
 *     pnpm --filter @pin/web test:smoke
 *
 * With BASE_URL unset every test skips, so the script is safe to run
 * anywhere. Read-only: no wallet, no writes.
 */
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/smoke",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  // A deploy preview's first hit on each route is a cold serverless start
  // plus live Postgres/RPC reads; one retry absorbs a cold-start timeout
  // without hiding a page that is actually broken.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
