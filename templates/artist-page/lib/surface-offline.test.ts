import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import {
  createDirectChainSurfaceProvider,
  type DirectChainClient,
} from "@pin/surface-kit"

const collection = "0x1111111111111111111111111111111111111111" as Address
const owner = "0x2222222222222222222222222222222222222222" as Address
const minter = "0x3333333333333333333333333333333333333333" as Address
const renderer = "0x4444444444444444444444444444444444444444" as Address
const account = "0x5555555555555555555555555555555555555555" as Address

function valueFor(name: string): unknown {
  if (name === "owner") return owner
  if (name === "config") return [{
    supplyCap: 12n,
    royaltyBps: 1000,
    royaltyReceiver: owner,
    renderer,
    rendererLocked: true,
    supplyLocked: true,
  }, 5n]
  if (name === "idMode") return 0
  if (name === "primaryMinter") return minter
  if (name === "collection") return collection
  if (name === "priceOf") return 100_000_000_000_000_000n
  if (name === "priceStrategy") return "0x0000000000000000000000000000000000000000"
  if (name === "mintStart" || name === "mintEnd" || name === "walletCap" || name === "mintedBy") return 0n
  if (name === "maxMints") return 12n
  if (name === "totalMinted") return 5n
  if (name === "allowlistRoot") return `0x${"00".repeat(32)}`
  if (name === "referralShareBps") return 1000
  throw new Error(`unexpected read ${name}`)
}

function client(): DirectChainClient {
  return {
    chain: { id: 1 },
    getBlockNumber: async () => 21_000_000n,
    readContract: async (args: { functionName: string }) => valueFor(args.functionName),
    multicall: async (args: { allowFailure?: boolean; contracts: { functionName: string }[] }) => {
      const values = args.contracts.map(({ functionName }) => valueFor(functionName))
      return args.allowFailure
        ? values.map((result) => ({ status: "success", result }))
        : values
    },
  }
}

describe("standalone Surface release path", () => {
  afterEach(() => vi.restoreAllMocks())

  it("validates, reads, quotes, and prepares a mint with PND hosts blocked", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (/pnd\.ripe\.wtf|art-pin\.netlify\.app/i.test(url)) {
        throw new Error(`PND endpoint blocked: ${url}`)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const provider = createDirectChainSurfaceProvider({ client: client(), source: "artist-rpc" })
    const validation = await provider.validateRelease({ chainId: 1, collection, protocol: "surface@1" })
    expect(validation.status).toBe("available")
    if (validation.status !== "available") return
    const state = await provider.readState(validation.value, account)
    expect(state.status).toBe("available")
    const quote = await provider.quoteMint({
      release: validation.value,
      account,
      quantity: 1n,
      referrer: owner,
    })
    expect(quote.status).toBe("available")
    if (quote.status !== "available") return
    const prepared = await provider.prepareMint({
      release: validation.value,
      account,
      quantity: 1n,
      referrer: owner,
      quote: quote.value,
    })
    expect(prepared.status).toBe("available")
    expect(network).not.toHaveBeenCalled()
  })

  it("keeps PND hostnames out of the release-critical template modules", async () => {
    const root = resolve(import.meta.dirname, "..")
    const files = [
      "components/CollectionMintCard.tsx",
      "components/CollectionTokenGrid.tsx",
      "lib/collection.ts",
      "lib/rpc.ts",
      "lib/surface.ts",
    ]
    const source = (await Promise.all(files.map((file) => readFile(resolve(root, file), "utf8")))).join("\n")
    expect(source).not.toMatch(/pnd\.ripe\.wtf|art-pin\.netlify\.app/i)
  })
})
