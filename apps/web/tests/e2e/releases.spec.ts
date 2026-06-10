/**
 * End-to-end: open a priced release and mint it through the real browser UI
 * (wallet auto-connected via PND's mock connector, Anvil signing
 * server-side), then assert the money model directly from the fork:
 * the artist accrued exactly price * qty, the surface is owed exactly
 * fee * qty, and the collector owns the token.
 */
import { e2eTest as test, expect } from "./fixtures/test"
import { createPublicClient, http, parseEther, type Address, type Chain } from "viem"
import { releaseAbi } from "@pin/abi"

const SHOTS = "tests/e2e/screenshots"
const SURFACE_FEE = parseEther("0.0005") // DeployReleases default

function forkChain(rpcUrl: string): Chain {
  return {
    id: 31339,
    name: "anvil-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
}

test("open a priced release then mint it end to end", async ({ page, state }) => {
  // ── open the release ────────────────────────────────────────────────────
  await page.goto("/releases/new")

  const title = page.getByLabel("Title", { exact: true })
  await expect(title).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SHOTS}/releases-01-create.png`, fullPage: true })

  await title.fill("E2E Release")
  await page.getByLabel("Symbol", { exact: true }).fill("E2ER")
  await page.getByLabel("Metadata URI", { exact: true }).fill("ipfs://QmE2EReleaseMeta")
  await page.getByLabel("Price (ETH)", { exact: true }).fill("0.01")
  await page.getByRole("button", { name: /^Deploy release$/ }).click()

  // Redirects to the release page on success.
  await page.waitForURL(/\/releases\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 })
  await page.screenshot({ path: `${SHOTS}/releases-02-page.png`, fullPage: true })

  const releaseAddr = new URL(page.url()).pathname.split("/")[2] as Address

  // The honest price block shows both legs before minting.
  await expect(page.getByText("To the artist")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("To this surface (flat fee)")).toBeVisible()

  // ── mint ────────────────────────────────────────────────────────────────
  const mintButton = page.getByRole("button", { name: /^Mint$/ })
  await expect(mintButton).toBeVisible({ timeout: 30_000 })
  await mintButton.click()
  await expect(page.getByText(/Minted onchain/i)).toBeVisible({ timeout: 90_000 })
  await page.screenshot({ path: `${SHOTS}/releases-03-minted.png`, fullPage: true })

  // ── assert the money model directly from the fork ──────────────────────
  const client = createPublicClient({
    chain: forkChain(state.rpcUrl),
    transport: http(state.rpcUrl),
  })
  const read = (functionName: string, args: unknown[] = []) =>
    client.readContract({
      address: releaseAddr,
      abi: releaseAbi,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: functionName as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
    })

  expect((await read("totalSupply")) as bigint).toBe(1n)
  expect(((await read("ownerOf", [1n])) as Address).toLowerCase()).toBe(
    state.impersonate.toLowerCase(),
  )

  // The artist gets everything they priced…
  expect((await read("artistBalance")) as bigint).toBe(parseEther("0.01"))
  // …and the surface is owed exactly the flat fee, nothing else.
  expect((await read("owed", [state.releaseSurface])) as bigint).toBe(SURFACE_FEE)
})

test("a free release is gas only, even through a surface", async ({ page, state }) => {
  await page.goto("/releases/new")

  const title = page.getByLabel("Title", { exact: true })
  await expect(title).toBeVisible({ timeout: 60_000 })
  await title.fill("E2E Free Release")
  await page.getByLabel("Symbol", { exact: true }).fill("FREE")
  await page.getByLabel("Metadata URI", { exact: true }).fill("ipfs://QmE2EFreeMeta")
  // price left empty => free
  await page.getByRole("button", { name: /^Deploy release$/ }).click()
  await page.waitForURL(/\/releases\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 })

  const releaseAddr = new URL(page.url()).pathname.split("/")[2] as Address

  // Appears in both the terms list and the mint CTA.
  await expect(page.getByText("Free (gas only)").first()).toBeVisible({
    timeout: 30_000,
  })

  const mintButton = page.getByRole("button", { name: /^Mint$/ })
  await mintButton.click()
  await expect(page.getByText(/Minted onchain/i)).toBeVisible({ timeout: 90_000 })

  const client = createPublicClient({
    chain: forkChain(state.rpcUrl),
    transport: http(state.rpcUrl),
  })
  // Free means free: no value reached the contract, nobody is owed anything.
  expect(
    await client.getBalance({ address: releaseAddr }),
  ).toBe(0n)
  expect(
    (await client.readContract({
      address: releaseAddr,
      abi: releaseAbi,
      functionName: "owed",
      args: [state.releaseSurface],
    })) as bigint,
  ).toBe(0n)
})
