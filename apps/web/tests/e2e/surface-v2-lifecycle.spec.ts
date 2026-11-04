/**
 * Surface v2 lifecycle through the studio, end to end (issue #364): launch a
 * primitive v2 collection with the create wizard (Launcher.launch), change
 * its price (FixedPriceSale.setPrice), gate it with an allowlist
 * (AllowlistGate.setRoot + setGate) and mint through the gate with a proof
 * from the proof route, airdrop 2 tokens (setMinter(owner) -> mintTo ->
 * setMinter(sale)), close the sale, and renounce ownership. Each step is
 * driven in the real app and verified against the fork's onchain state.
 *
 * The allowlist step needs the app's Postgres allowlist store
 * (E2E_DATABASE_URL, see fixtures/globalSetup.ts); without one, that step
 * is skipped and the rest still runs.
 *
 * Set E2E_SHOTS_DIR to save a screenshot of each panel state there.
 */
import { createPublicClient, encodeAbiParameters, http, parseEther, type Address } from "viem"
import { allowlistGateAbi, fixedPriceSaleAbi, surfaceTokenV2Abi } from "@pin/abi"
import { e2eTest as test, expect, type Page } from "./fixtures/test"

const NAME = "Lifecycle Studies"
const AIRDROP_A = "0x000000000000000000000000000000000000a11a" as Address
const AIRDROP_B = "0x000000000000000000000000000000000000b22b" as Address
const ALLOWLISTED_OTHER = "0x000000000000000000000000000000000000c33c" as Address
const ZERO = "0x0000000000000000000000000000000000000000"

async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  await page.screenshot({ path: `${dir}/b5-${name}.png`, fullPage: true })
}

test.describe.configure({ mode: "serial" })

test.describe("Surface v2: studio lifecycle", () => {
  let collection: Address
  let sale: Address

  const client = (rpcUrl: string) => createPublicClient({ transport: http(rpcUrl) })

  test("launch a v2 collection through the wizard", async ({ page, state }) => {
    await page.goto(`/studio/${state.impersonate.toLowerCase()}/create`)
    await expect(page.getByRole("heading", { name: "Launch a collection" })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/and its fixed-price sale/)).toBeVisible()

    await page.getByLabel("Renderer contract address").fill(state.renderer)
    const next = page.getByRole("button", { name: "Continue" })
    await expect(next).toBeEnabled({ timeout: 15_000 })
    await next.click()

    await page.getByLabel("Name").fill(NAME)
    await page.getByLabel("Symbol").fill("LIFE")
    // v2 has no onchain creator roster: credit lives in the Catalog.
    await expect(page.getByText("Co-creators are credited in the Catalog")).toBeVisible()
    await page.getByRole("button", { name: "Continue" }).click()

    await page.getByLabel("Price (ETH)").fill("0.01")
    await page.getByLabel("Open supply (no cap)").uncheck()
    await page.getByPlaceholder("Max supply").fill("10")
    await page.getByRole("button", { name: "Continue" }).click()

    await expect(page.getByRole("heading", { name: "Review and deploy" })).toBeVisible()
    await expect(page.getByText("10% to you")).toBeVisible()
    await shot(page, "create-review")
    await page.getByRole("button", { name: "Deploy collection" }).click()

    const view = page.getByRole("link", { name: "View collection" })
    await expect(view).toBeVisible({ timeout: 60_000 })
    await shot(page, "create-success")
    collection = (await view.getAttribute("href"))!.split("/").pop() as Address
    const saleText = (await page.getByText(/^Sale: 0x/).textContent()) ?? ""
    sale = saleText.replace("Sale: ", "").trim() as Address

    const c = client(state.rpcUrl)
    const [owner, minter, cap, version] = await Promise.all([
      c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "owner" }),
      c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "minter" }),
      c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "supplyCap" }),
      c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "version" }),
    ])
    expect(version).toBe(2n)
    expect(owner.toLowerCase()).toBe(state.impersonate.toLowerCase())
    expect(minter.toLowerCase()).toBe(sale.toLowerCase())
    expect(cap).toBe(10n)
    // Royalty defaults to the owner (the Launcher maps a zero receiver).
    const receiver = await c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "royaltyReceiver" })
    expect(receiver.toLowerCase()).toBe(state.impersonate.toLowerCase())
  })

  test("change the price on the sale panel", async ({ page, state }) => {
    await page.goto(`/studio/${state.impersonate.toLowerCase()}/sale?collection=${collection}`)
    await expect(page.getByText("Sale onchain now")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("0.01 ETH")).toBeVisible()
    await shot(page, "sale-panel")

    await page.getByLabel("Price (ETH)").fill("0.02")
    await page.getByRole("button", { name: "Save price" }).click()
    await expect(page.getByText("0.02 ETH")).toBeVisible({ timeout: 60_000 })

    const price = await client(state.rpcUrl).readContract({ address: sale, abi: fixedPriceSaleAbi, functionName: "price" })
    expect(price).toBe(parseEther("0.02"))
  })

  test("gate the sale with an allowlist, then mint through it with a proof", async ({ page, state }) => {
    test.skip(!state.database, "needs the allowlist store (E2E_DATABASE_URL)")
    await page.goto(`/studio/${state.impersonate.toLowerCase()}/mint-gate?collection=${collection}`)
    await expect(page.getByText("Current gate state")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Not gated: anyone can mint")).toBeVisible()

    await page.getByLabel("Addresses").fill(`${state.impersonate}\n${ALLOWLISTED_OTHER}`)
    await page.getByRole("button", { name: "Publish list" }).click()
    await expect(page.getByText("Published", { exact: true })).toBeVisible({ timeout: 30_000 })
    await shot(page, "mint-gate-published")

    await page.getByRole("button", { name: "Activate allowlist" }).click()
    await expect(page.getByText("Allowlist (AllowlistGate)")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText("2 addresses", { exact: true })).toBeVisible()
    await shot(page, "mint-gate-active")

    const c = client(state.rpcUrl)
    const gate = await c.readContract({ address: sale, abi: fixedPriceSaleAbi, functionName: "gate" })
    expect(gate.toLowerCase()).toBe(state.v2.allowlistGate.toLowerCase())

    // The proof route, keyed by collection, serves a proof that the
    // AllowlistGate accepts onchain.
    const res = await page.request.get(`/api/collections/${collection}/allowlist?wallet=${state.impersonate}`)
    const body = (await res.json()) as { gated: boolean; eligible: boolean; proof?: `0x${string}`[] }
    expect(body.gated).toBe(true)
    expect(body.eligible).toBe(true)
    const ok = await c.readContract({
      address: state.v2.allowlistGate,
      abi: allowlistGateAbi,
      functionName: "check",
      args: [collection, state.impersonate, 1n, encodeAbiParameters([{ type: "bytes32[]" }], [body.proof!])],
    })
    expect(ok).toBe(true)
    const outsider = (await (
      await page.request.get(`/api/collections/${collection}/allowlist?wallet=${AIRDROP_A}`)
    ).json()) as { eligible: boolean }
    expect(outsider.eligible).toBe(false)

    // The collection page's mint button fetches that proof and mints.
    await page.goto(`/collections/${collection}`)
    await page.getByRole("button", { name: /^Mint for/ }).click()
    await expect(page.getByText(/Token #1 is yours/)).toBeVisible({ timeout: 60_000 })
    const soldThroughSale = await c.readContract({ address: sale, abi: fixedPriceSaleAbi, functionName: "totalMinted" })
    expect(soldThroughSale).toBe(1n)
  })

  test("airdrop 2 tokens with the owner holding the minter slot", async ({ page, state }) => {
    const c = client(state.rpcUrl)
    const [mintedBefore, soldBefore] = await Promise.all([
      c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "totalSupply" }),
      c.readContract({ address: sale, abi: fixedPriceSaleAbi, functionName: "totalMinted" }),
    ])

    await page.goto(`/studio/${state.impersonate.toLowerCase()}/collections?collection=${collection}`)
    await expect(page.getByText("Onchain now")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/\(fixed-price sale\)/)).toBeVisible()
    // The sale is still open with no end: renounce is refused.
    await expect(page.getByText(/The sale has no mint end/)).toBeVisible()
    await shot(page, "settings-panel")

    await page.getByLabel("Recipients").fill(`${AIRDROP_A}\n${AIRDROP_B}`)
    await expect(page.getByText(/2 tokens to 2 wallets/)).toBeVisible()
    await expect(page.getByText(/The public sale is paused while your wallet holds the minter slot/)).toBeVisible()
    await shot(page, "airdrop-ready")
    await page.getByRole("button", { name: "Airdrop 2" }).click()

    const expectedSupply = `${mintedBefore + 2n} / 10 minted`
    await expect(page.getByText(expectedSupply)).toBeVisible({ timeout: 90_000 })
    await shot(page, "airdrop-done")

    const [balA, balB, minter, soldAfter] = await Promise.all([
      c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "balanceOf", args: [AIRDROP_A] }),
      c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "balanceOf", args: [AIRDROP_B] }),
      c.readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "minter" }),
      c.readContract({ address: sale, abi: fixedPriceSaleAbi, functionName: "totalMinted" }),
    ])
    expect(balA).toBe(1n)
    expect(balB).toBe(1n)
    // The slot is back with the sale, and owner mints never count there.
    expect(minter.toLowerCase()).toBe(sale.toLowerCase())
    expect(soldAfter).toBe(soldBefore)
  })

  test("close the sale", async ({ page, state }) => {
    await page.goto(`/studio/${state.impersonate.toLowerCase()}/sale?collection=${collection}`)
    await expect(page.getByText("Sale onchain now")).toBeVisible({ timeout: 30_000 })
    await page.getByLabel(`Type ${NAME} to confirm`).fill(NAME)
    await shot(page, "sale-close-confirm")
    await page.getByRole("button", { name: "Close sale" }).click()
    await expect(page.getByText(/This sale is closed for good/)).toBeVisible({ timeout: 60_000 })
    await shot(page, "sale-closed")
    const closed = await client(state.rpcUrl).readContract({ address: sale, abi: fixedPriceSaleAbi, functionName: "closed" })
    expect(closed).toBe(true)
  })

  test("renounce ownership once the sale is closed", async ({ page, state }) => {
    await page.goto(`/studio/${state.impersonate.toLowerCase()}/collections?collection=${collection}`)
    await expect(page.getByText("Onchain now")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("The sale is closed.", { exact: true })).toBeVisible()
    await page.getByLabel(`Type ${NAME} to confirm`).fill(NAME)
    await shot(page, "renounce-confirm")
    await page.getByRole("button", { name: "Renounce ownership" }).click()
    await expect(page.getByText(/Ownership is renounced\. The renderer/)).toBeVisible({ timeout: 60_000 })
    await shot(page, "renounced")
    const owner = await client(state.rpcUrl).readContract({ address: collection, abi: surfaceTokenV2Abi, functionName: "owner" })
    expect(owner).toBe(ZERO)
  })
})
