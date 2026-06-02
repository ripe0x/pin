/**
 * End-to-end: deploy an edition and mint it, through the real browser UI with
 * the wallet auto-connected (PND's mock connector) and Anvil signing
 * server-side. Asserts the resulting onchain state (ownership, supply, Mint
 * Mark) directly from the fork.
 */
import { e2eTest as test, expect } from "./fixtures/test"
import { createPublicClient, http, type Address, type Chain } from "viem"
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

test("create an edition then mint it end to end", async ({ page, state }) => {
  // ── create the edition (one step) ──────────────────────────────────────────
  await page.goto("/editions/new")

  const title = page.getByLabel("Title", { exact: true })
  await expect(title).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SHOTS}/01-create-connected.png`, fullPage: true })

  await title.fill("E2E Edition")
  await page.getByLabel("Symbol", { exact: true }).fill("E2E")
  await page.getByLabel("Artwork URI", { exact: true }).fill("ipfs://QmE2EArtwork")
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
