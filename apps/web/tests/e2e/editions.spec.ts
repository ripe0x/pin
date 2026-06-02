/**
 * End-to-end: deploy a project, publish a gas-only release, and mint it,
 * all through the real browser UI with the wallet auto-connected (PND's mock
 * connector) and Anvil signing server-side. Asserts the resulting onchain
 * state (ownership, supply, Mint Mark) directly from the fork.
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

test("release then mint a PND Edition end to end", async ({ page, state }) => {
  // ── create: deploy project ───────────────────────────────────────────────
  await page.goto("/editions/new")

  // Auto-connect resolves, then the deploy form renders.
  const nameInput = page.getByLabel("Project name", { exact: true })
  await expect(nameInput).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SHOTS}/01-create-connected.png`, fullPage: true })

  await nameInput.fill("E2E Editions Project")
  await page.getByLabel("Symbol", { exact: true }).fill("E2E")
  await page.getByRole("button", { name: /^Deploy project$/ }).click()

  // Deploy tx mines on Anvil; the flow advances to step 2.
  await expect(page.getByText(/Project deployed at/i)).toBeVisible({ timeout: 90_000 })
  await page.screenshot({ path: `${SHOTS}/02-project-deployed.png`, fullPage: true })

  // ── create: publish a gas-only release ─────────────────────────────────────
  await page.getByLabel("Artwork URI", { exact: true }).fill("ipfs://QmE2EArtwork")
  // price left empty => gas only
  await page.getByRole("button", { name: /^Publish release$/ }).click()

  // Redirects to the release page on success.
  await page.waitForURL(/\/editions\/0x[0-9a-fA-F]{40}\/0$/, { timeout: 90_000 })
  await page.screenshot({ path: `${SHOTS}/03-release-page.png`, fullPage: true })

  const project = new URL(page.url()).pathname.split("/")[2] as Address

  // ── mint ───────────────────────────────────────────────────────────────────
  const mintButton = page.getByRole("button", { name: /^Mint/ })
  await expect(mintButton).toBeVisible({ timeout: 30_000 })
  await mintButton.click()
  await expect(page.getByText(/Your Mint Mark is recorded onchain/i)).toBeVisible({
    timeout: 90_000,
  })
  await page.screenshot({ path: `${SHOTS}/04-mint-success.png`, fullPage: true })

  // ── assert onchain state directly from the fork ────────────────────────────
  const client = createPublicClient({ chain: forkChain(state.rpcUrl), transport: http(state.rpcUrl) })

  const totalSupply = (await client.readContract({
    address: project,
    abi: pndEditionsAbi,
    functionName: "totalSupply",
  })) as bigint
  expect(totalSupply).toBe(1n)

  const owner = (await client.readContract({
    address: project,
    abi: pndEditionsAbi,
    functionName: "ownerOf",
    args: [1n],
  })) as Address
  expect(owner.toLowerCase()).toBe(state.impersonate.toLowerCase())

  const mark = (await client.readContract({
    address: project,
    abi: pndEditionsAbi,
    functionName: "mintMarkOf",
    args: [1n],
  })) as { releaseId: number; indexInRelease: number; isFirst: boolean }
  expect(Number(mark.releaseId)).toBe(0)
  expect(Number(mark.indexInRelease)).toBe(0)
  expect(mark.isFirst).toBe(true)
})
