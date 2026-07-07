/**
 * PND Collections e2e: the studio create-collection wizard, driven as a real
 * user would — click through the wizard in a real Chromium browser against a
 * real Anvil mainnet fork, then verify the resulting onchain state through
 * the app's own read paths (the collection page, the token page).
 *
 * Two serial tests sharing the one fork `globalSetup` brings up:
 *
 *   1. EDITION preset, full create -> deploy -> mint -> verify Mint Mark.
 *      Exercises the whole write path: createCollection on
 *      SovereignCollectionFactory, then mintWithRewards on the deployed
 *      clone, then reads the collection + token pages for the resulting
 *      state (name, status, price, minted count, Mint Mark, seed).
 *
 *   2. GENERATIVE preset, create -> config -> PREVIEW only. Upload (chunked
 *      ScriptyStorageV2 writes) + deploy is deliberately NOT exercised here:
 *      it's ~2 minutes of chained txs and test 1 already covers the
 *      deploy/mint plumbing end to end. This test's job is to prove the
 *      preview step's parity builder actually assembles real forked EthFS
 *      dependency bytes into each iframe's srcdoc (a builder bug would show
 *      up as a tiny/empty srcdoc or a caught "preview failed" error, not a
 *      thrown exception — hence checking the doc size directly rather than
 *      just "no error banner").
 *
 * Selector strategy: role/label selectors throughout (getByRole, getByLabel,
 * getByText), matching the wizard's real accessible names — the wizard forms
 * already wire every input's `id`/`htmlFor` correctly (see SharedFields.tsx,
 * GenerativeFields.tsx), so no test ids were needed and none were added.
 *
 * The studio URL uses the LOWERCASE impersonated account address deliberately
 * — the studio layout redirects any non-canonical-case address to its
 * lowercase form (see app/studio/[address]/layout.tsx), and OwnerGate only
 * renders the wizard when the connected wallet matches the studio address,
 * so the "artist" here is simply the impersonated dev wallet itself.
 */
import { e2eTest as test, expect } from "./fixtures/test"

test.describe.configure({ mode: "serial" })

const ART = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/edition-cover.png"

test.describe("Collections: create-and-mint (EDITION)", () => {
  let collectionAddress: `0x${string}`

  test("deploy an EDITION collection end to end", async ({ page, state }) => {
    const studioUrl = `/studio/${state.impersonate.toLowerCase()}/create`
    await page.goto(studioUrl)

    // OwnerGate needs the mock connector's auto-connect to land before the
    // wizard renders; the "Create a collection" header only appears once
    // `isOwner` is true, so waiting for it also proves auto-connect worked.
    await expect(page.getByRole("heading", { name: "Create a collection" })).toBeVisible({
      timeout: 30_000,
    })

    // ── Preset step ──
    await page.getByRole("button", { name: "Edition" }).click()

    // ── Configure step ──
    await expect(page.getByLabel("Name")).toBeVisible()
    await page.getByLabel("Name").fill("Studies in Grey")
    await page.getByLabel("Symbol").fill("GREY")
    await page.getByLabel("Artwork URI").fill(ART)
    await page.getByLabel("Price (ETH)").fill("0.01")
    // Cap the supply at 10: uncheck "Open supply (no cap)" then fill the cap.
    await page.getByLabel("Open supply (no cap)").uncheck()
    await page.getByPlaceholder("Max supply").fill("10")

    await page.getByRole("button", { name: "Continue" }).click()

    // ── Deploy step ──
    await expect(page.getByRole("heading", { name: "Deploy" })).toBeVisible()
    await page.getByRole("button", { name: "Deploy collection" }).click()

    // Deploy is a single tx (create + fund + first block on a cold fork can
    // be slow) — generous timeout, no fixed sleep.
    const viewCollectionLink = page.getByRole("link", { name: "View collection" })
    await expect(viewCollectionLink).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText("Collection deployed")).toBeVisible()

    const href = await viewCollectionLink.getAttribute("href")
    expect(href).toBeTruthy()
    const match = href!.match(/^\/collections\/(0x[0-9a-fA-F]{40})$/)
    expect(match).not.toBeNull()
    collectionAddress = match![1] as `0x${string}`

    // ── Visit the collection page: assert name, OPEN status, price ──
    await page.goto(`/collections/${collectionAddress}`)
    await expect(page.getByRole("heading", { name: "Studies in Grey" })).toBeVisible()
    await expect(page.getByText("Open", { exact: true })).toBeVisible()
    await expect(page.getByText("0.01", { exact: false }).first()).toBeVisible()
    await expect(page.getByText("0 / 10 minted")).toBeVisible()

    // ── Mint 1 via the CTA ──
    await page.getByRole("button", { name: /^Mint for/ }).click()
    await expect(page.getByText("Minted. Your Mint Mark is recorded onchain.")).toBeVisible({
      timeout: 60_000,
    })

    // Minted count is server-rendered from a fresh onchain read — reload
    // (rather than trust client-side router.refresh timing) and poll until
    // the new state has propagated, since the fork's next block + the app's
    // own read path both need to settle.
    await expect
      .poll(
        async () => {
          await page.goto(`/collections/${collectionAddress}`)
          return (await page.getByText(/minted$/).first().textContent()) ?? ""
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toContain("1 / 10 minted")

    // ── Visit the token page: assert Mint Mark order #1 + seed hex ──
    await page.goto(`/collections/${collectionAddress}/1`)
    await expect(page.getByText("#1 in the collection")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("First mint of the collection")).toBeVisible()

    const seedSection = page.locator("text=Seed").locator("..").locator("..")
    await expect(seedSection.getByText(/^0x[0-9a-fA-F]+$/)).toBeVisible()
  })
})

test.describe("Collections: create (GENERATIVE, preview only)", () => {
  test("preview a GENERATIVE collection through the parity builder", async ({ page, state }) => {
    const studioUrl = `/studio/${state.impersonate.toLowerCase()}/create`
    await page.goto(studioUrl)

    await expect(page.getByRole("heading", { name: "Create a collection" })).toBeVisible({
      timeout: 30_000,
    })

    // ── Preset step ──
    await page.getByRole("button", { name: "Generative" }).click()

    // ── Configure step ──
    await page.getByLabel("Name").fill("Grid Study")
    await page.getByLabel("Symbol").fill("GRID")
    await page.getByLabel("Price (ETH)").fill("0.02")

    const script = [
      "function setup() {",
      "  createCanvas(400, 400)",
      "  noLoop()",
      "}",
      "",
      "function draw() {",
      "  const hash = tokenData.hash || '0x00'",
      "  const seed = parseInt(hash.slice(2, 10), 16)",
      "  background(seed % 255, 40, 200)",
      "}",
    ].join("\n")
    await page.getByLabel("Script").fill(script)

    // Dependency checkbox: label is a <span> sibling of the <input>, not a
    // <label for>, but KNOWN_DEPENDENCIES renders it inside a <label> wrapper
    // so getByLabel still resolves it by accessible name.
    await page.getByLabel("p5.js 1.5.0").check()

    await page.getByRole("button", { name: "Continue" }).click()

    // ── Preview step ──
    await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible()

    const previewFrames = page.locator('iframe[title^="Test seed "]')
    await expect(previewFrames).toHaveCount(4)

    // The parity builder resolves the p5 dependency from the forked EthFS
    // store and inlines it into the srcdoc — a real assembled document is
    // >100KB (p5.js alone gzip-decompressed is well over that). A builder
    // regression that silently drops the dependency or falls through to an
    // error path would produce a tiny placeholder document instead, so this
    // is the load-bearing assertion for this test, not just "no crash".
    for (let i = 0; i < 4; i++) {
      await expect
        .poll(
          async () => {
            const srcdoc = await previewFrames.nth(i).getAttribute("srcdoc")
            return srcdoc?.length ?? 0
          },
          { timeout: 45_000, intervals: [1_000, 2_000, 3_000] },
        )
        .toBeGreaterThan(100_000)
    }

    const continueButton = page.getByRole("button", { name: "Looks right, continue" })
    await expect(continueButton).toBeVisible()
    await expect(continueButton).toBeEnabled()
  })
})
