/**
 * PND Collections e2e: the studio create-collection wizard, driven as a real
 * user would — click through the wizard in a real Chromium browser against a
 * real Anvil mainnet fork, then verify the resulting onchain state through
 * the app's own read paths (the collection page, the token page).
 *
 * The currently supported Renderer-native preset runs end to end: deploy,
 * mint, and verify through the app's collection and token read paths. The
 * test also asserts the guided Edition and Generative presets remain disabled
 * while the mainnet factory has no default/shared renderer.
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

test.describe("Collections: create-and-mint (Renderer native)", () => {
  let collectionAddress: `0x${string}`

  test("deploy a renderer-native collection end to end", async ({ page, state }) => {
    const studioUrl = `/studio/${state.impersonate.toLowerCase()}/create`
    await page.goto(studioUrl)

    // OwnerGate needs the mock connector's auto-connect to land before the
    // wizard renders; the "Create a collection" header only appears once
    // `isOwner` is true, so waiting for it also proves auto-connect worked.
    await expect(page.getByRole("heading", { name: "Create a collection" })).toBeVisible({
      timeout: 30_000,
    })

    // ── Preset step ──
    await expect(page.getByRole("button", { name: /^Edition\b/ })).toBeDisabled()
    await expect(page.getByRole("button", { name: /^Generative\b/ })).toBeDisabled()
    const rendererPreset = page.getByRole("button", { name: /^Renderer native\b/ })
    await expect(rendererPreset).toBeEnabled()
    await rendererPreset.click()

    // ── Configure step ──
    await expect(page.getByLabel("Name")).toBeVisible()
    await page.getByLabel("Name").fill("Studies in Grey")
    await page.getByLabel("Symbol").fill("GREY")
    await page.getByLabel("Renderer contract address").fill(state.renderer)
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
    await expect(page.getByText("Token #1 is yours. Its Mint Mark is recorded onchain.")).toBeVisible({
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
