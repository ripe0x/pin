/**
 * End-to-end: deploy an edition and mint it, through the real browser UI with
 * the wallet auto-connected (PND's mock connector) and Anvil signing
 * server-side. Asserts the resulting onchain state (ownership, supply, Mint
 * Mark) directly from the fork.
 *
 * A second spec drives the two paths that the editions-on-MURI merge re-wired
 * into the redesigned create form: the 0xSplits collaborator flow (two-step
 * split -> edition deploy) and the Permanent tier (edition deployed pointing at
 * the MURI renderer).
 */
import { e2eTest as test, expect, type Page } from "./fixtures/test"
import { createPublicClient, http, isAddress, zeroAddress, type Address, type Chain } from "viem"
import { pndEditionsAbi } from "@pin/abi"

const SHOTS = "tests/e2e/screenshots"

function forkChain(rpcUrl: string): Chain {
  return {
    id: 31339,
    name: "anvil-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
}

/**
 * Fill the artwork field. The form uses the ArtworkInput component, which
 * defaults to an upload dropzone — switch it to "Paste URI" and type a URI.
 */
async function pasteArtworkUri(page: Page, uri: string) {
  await page.getByRole("tab", { name: "Paste URI" }).click()
  await page.getByPlaceholder(/ipfs:\/\//).fill(uri)
}

test("create an edition then mint it end to end", async ({ page, state }) => {
  // ── create the edition (one step) ──────────────────────────────────────────
  await page.goto("/editions/new")

  const title = page.getByLabel("Title", { exact: true })
  await expect(title).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SHOTS}/01-create-connected.png`, fullPage: true })

  await title.fill("E2E Edition")
  await page.getByLabel("Symbol", { exact: true }).fill("E2E")
  await pasteArtworkUri(page, "ipfs://QmE2EArtwork")
  // price left empty => gas only
  await page.getByRole("button", { name: /^Deploy edition$/ }).click()

  // Redirects to the edition page on success.
  await page.waitForURL(/\/editions\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 })
  await page.screenshot({ path: `${SHOTS}/02-edition-page.png`, fullPage: true })

  const editionAddr = new URL(page.url()).pathname.split("/")[2] as Address

  // ── mint ───────────────────────────────────────────────────────────────────
  const mintButton = page.getByRole("button", { name: /^Mint/ })
  await expect(mintButton).toBeVisible({ timeout: 30_000 })
  await mintButton.click()
  await expect(page.getByText(/Your Mint Mark is recorded onchain/i)).toBeVisible({
    timeout: 90_000,
  })
  await page.screenshot({ path: `${SHOTS}/03-mint-success.png`, fullPage: true })

  // Mint history populates in the sidebar after a reload.
  await page.reload()
  await expect(page.getByText("Mint history")).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: `${SHOTS}/04-mint-history.png`, fullPage: true })

  // ── assert onchain state directly from the fork ────────────────────────────
  const client = createPublicClient({
    chain: forkChain(state.rpcUrl),
    transport: http(state.rpcUrl),
  })

  const totalSupply = (await client.readContract({
    address: editionAddr,
    abi: pndEditionsAbi,
    functionName: "totalSupply",
  })) as bigint
  expect(totalSupply).toBe(1n)

  const owner = (await client.readContract({
    address: editionAddr,
    abi: pndEditionsAbi,
    functionName: "ownerOf",
    args: [1n],
  })) as Address
  expect(owner.toLowerCase()).toBe(state.impersonate.toLowerCase())

  const mark = (await client.readContract({
    address: editionAddr,
    abi: pndEditionsAbi,
    functionName: "mintMarkOf",
    args: [1n],
  })) as { indexInEdition: number; isFirst: boolean }
  expect(Number(mark.indexInEdition)).toBe(0)
  expect(mark.isFirst).toBe(true)
})

test("create a Permanent-tier edition with collaborator splits", async ({ page, state }) => {
  // This spec exercises the two flows the editions-on-MURI merge re-integrated
  // into the redesigned form, so it needs the MURI renderer wired (Permanent
  // tier is gated on it).
  expect(state.muriRenderer, "MURI renderer should be deployed on the fork").toBeTruthy()
  const muriRenderer = state.muriRenderer as Address

  // Two distinct collaborators (Anvil accounts 1 & 2), shares summing to 100.
  const collabA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address
  const collabB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address

  await page.goto("/editions/new")
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible({ timeout: 60_000 })

  await page.getByLabel("Title", { exact: true }).fill("Split Permanent")
  await page.getByLabel("Symbol", { exact: true }).fill("SPLIT")
  await pasteArtworkUri(page, "ipfs://QmSplitPermanentArt")

  // Permanent tier (presets the MURI renderer).
  await page.getByRole("button", { name: /^Permanent/ }).click()

  // Enable collaborator splits and fill two rows.
  await page
    .locator("label", { hasText: "Split proceeds with collaborators" })
    .locator('input[type="checkbox"]')
    .check()
  const addrInputs = page.getByPlaceholder("0x… collaborator")
  const pctInputs = page.getByPlaceholder("%")
  await addrInputs.nth(0).fill(collabA)
  await pctInputs.nth(0).fill("60")
  await addrInputs.nth(1).fill(collabB)
  await pctInputs.nth(1).fill("40")

  await page.screenshot({ path: `${SHOTS}/05-split-permanent-form.png`, fullPage: true })

  // Two-step deploy: createSplit, then the edition pointing payout at it.
  await page.getByRole("button", { name: /Deploy split \+ edition/ }).click()
  await page.waitForURL(/\/editions\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 })
  await page.screenshot({ path: `${SHOTS}/06-split-permanent-edition.png`, fullPage: true })

  const editionAddr = new URL(page.url()).pathname.split("/")[2] as Address

  // ── assert onchain: Permanent renderer + payout routed to a real split ──────
  const client = createPublicClient({
    chain: forkChain(state.rpcUrl),
    transport: http(state.rpcUrl),
  })

  // Permanent tier => the edition's renderer is the MURI renderer.
  const renderer = (await client.readContract({
    address: editionAddr,
    abi: pndEditionsAbi,
    functionName: "renderer",
  })) as Address
  expect(renderer.toLowerCase()).toBe(muriRenderer.toLowerCase())

  // The payout is the freshly-deployed 0xSplits split: a real contract, not the
  // artist and not zero.
  const [cfg] = (await client.readContract({
    address: editionAddr,
    abi: pndEditionsAbi,
    functionName: "config",
  })) as [{ payoutAddress: Address }, unknown, unknown]
  const payout = cfg.payoutAddress
  expect(isAddress(payout)).toBe(true)
  expect(payout.toLowerCase()).not.toBe(zeroAddress)
  expect(payout.toLowerCase()).not.toBe(state.impersonate.toLowerCase())
  const splitCode = await client.getCode({ address: payout })
  expect(splitCode && splitCode !== "0x").toBeTruthy()
})
