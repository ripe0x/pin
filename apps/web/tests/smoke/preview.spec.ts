/**
 * Deployed-site smoke test: a few key pages and the indexer health route,
 * run against BASE_URL (a Netlify deploy preview in CI, see
 * .github/workflows/preview-smoke.yml). Read-only.
 *
 * Each page must answer HTTP 200, render its main heading, and show none of
 * the error-boundary copy (the route error.tsx files all say "Could not load
 * this …" / "This usually clears in a moment.") or Next's own crash pages.
 *
 * Targets are long-lived mainnet records, chosen so the test doesn't churn:
 *   - artist: djkero, linked from the site footer (components/Footer.tsx)
 *   - token: Foundation's shared 1/1 contract, token #1 (the platform's
 *     first mint; FOUNDATION_NFT in @pin/addresses)
 *   - mint: Form of Solitude (lib/mint-modules/form-of-solitude.ts)
 * Heading assertions use fixed copy only where the page owns it; artist and
 * token titles come from ENS/metadata, so those just need a real h1 that is
 * not the page's own not-found state.
 */
import { test, expect, type Page } from "@playwright/test"

const BASE_URL = process.env.BASE_URL

const ERROR_COPY =
  /Could not load this|This usually clears in a moment|Application error|client-side exception|Internal Server Error|This page could not be found/i

const DJKERO = "0xc83e83677dd95618686ac9af2cd48972f1b72c22"
const FOUNDATION_NFT = "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405"

type PageCheck = {
  name: string
  path: string
  /** Exact h1 copy the page owns, or a pattern the h1 must not match. */
  heading: { is: string } | { not: RegExp }
}

const PAGES: PageCheck[] = [
  { name: "landing", path: "/", heading: { is: "Artist-owned releases" } },
  { name: "artist page", path: `/artist/${DJKERO}`, heading: { not: /^\s*Not Found\s*$/i } },
  { name: "token page", path: `/${FOUNDATION_NFT}/1`, heading: { not: /Token not found/i } },
  { name: "collections", path: "/collections", heading: { is: "Collections" } },
  { name: "Form of Solitude mint", path: "/mint/form-of-solitude", heading: { is: "Form of Solitude" } },
]

async function expectNoErrorBoundary(page: Page) {
  await expect(page.locator("body")).not.toContainText(ERROR_COPY)
}

test.describe("deployed site smoke", () => {
  test.skip(!BASE_URL, "BASE_URL is not set; nothing to smoke-test")

  for (const check of PAGES) {
    test(`${check.name} (${check.path}) renders`, async ({ page }) => {
      const response = await page.goto(check.path, { waitUntil: "domcontentloaded" })
      expect(response, `no response for ${check.path}`).not.toBeNull()
      expect(response!.status(), `HTTP status for ${check.path}`).toBe(200)

      const h1 = page.locator("h1").first()
      if ("is" in check.heading) {
        await expect(page.getByRole("heading", { level: 1, name: check.heading.is })).toBeVisible()
      } else {
        await expect(h1).toBeVisible()
        await expect(h1).not.toHaveText(check.heading.not)
        await expect(h1).not.toHaveText(/^\s*$/)
      }
      await expectNoErrorBoundary(page)
    })
  }

  test("indexer health (/api/health/indexer) is fresh", async ({ request }) => {
    const response = await request.get("/api/health/indexer")
    const body = (await response.json().catch(() => null)) as {
      schema?: string
      ageSeconds?: number
      latestBlock?: number
    } | null
    // 503 means the configured INDEXER_SCHEMA is stale or unreadable: the
    // exact failure this route exists to surface. Print the body either way.
    expect(response.status(), `health body: ${JSON.stringify(body)}`).toBe(200)
    expect(body?.schema).toMatch(/^ponder_v\d+$/)
    expect(typeof body?.ageSeconds).toBe("number")
    expect(typeof body?.latestBlock).toBe("number")
  })
})
