import assert from "node:assert/strict"
import test from "node:test"
import type { Address } from "viem"
import {
  IdMode,
  SurfaceStatus,
  createDirectChainSurfaceProvider,
  releaseAvailability,
  type DirectChainClient,
  type ReleaseState,
  type SurfaceMintAdapter,
} from "./index.ts"

const collection = "0x1111111111111111111111111111111111111111" as Address
const owner = "0x2222222222222222222222222222222222222222" as Address
const minter = "0x3333333333333333333333333333333333333333" as Address
const otherMinter = "0x9999999999999999999999999999999999999999" as Address
const renderer = "0x4444444444444444444444444444444444444444" as Address
const account = "0x5555555555555555555555555555555555555555" as Address
const root = `0x${"11".repeat(32)}` as `0x${string}`
const zeroRoot = `0x${"00".repeat(32)}` as `0x${string}`

type Options = {
  price?: bigint
  mintStart?: bigint
  mintEnd?: bigint
  supplyCap?: bigint
  minted?: bigint
  saleCap?: bigint
  saleMinted?: bigint
  allowlistRoot?: `0x${string}`
  walletCap?: bigint
  mintedBy?: bigint
  compatibleMinter?: boolean
  fail?: boolean
  tokenUri?: string | null
}

function fixtureClient(options: Options = {}): DirectChainClient {
  const valueFor = (name: string, args?: readonly unknown[]): unknown => {
    if (options.fail) throw new Error("fixture RPC failure")
    switch (name) {
      case "owner": return owner
      case "config": return [{
        supplyCap: options.supplyCap ?? 12n,
        royaltyBps: 1000,
        royaltyReceiver: owner,
        renderer,
        rendererLocked: true,
        supplyLocked: true,
      }, options.minted ?? 5n]
      case "idMode": return IdMode.Sequential
      case "primaryMinter": return minter
      case "collection": return options.compatibleMinter === false ? otherMinter : collection
      case "priceOf": return (options.price ?? 100n) * BigInt((args?.[1] as bigint | undefined) ?? 1n)
      case "priceStrategy": return zeroRoot.slice(0, 42)
      case "mintStart": return options.mintStart ?? 0n
      case "mintEnd": return options.mintEnd ?? 0n
      case "maxMints": return options.saleCap ?? 12n
      case "totalMinted": return options.saleMinted ?? 5n
      case "allowlistRoot": return options.allowlistRoot ?? zeroRoot
      case "walletCap": return options.walletCap ?? 0n
      case "referralShareBps": return 1000
      case "mintedBy": return options.mintedBy ?? 0n
      case "ownerOf": return account
      case "tokenSeed": return `0x${"12".repeat(32)}`
      default: throw new Error(`unexpected fixture read ${name}`)
    }
  }
  return {
    chain: { id: 1 },
    getBlockNumber: async () => {
      if (options.fail) throw new Error("fixture RPC failure")
      return 21_000_000n
    },
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === "isSurface") return true
      if (args.functionName === "tokenURI") {
        if (options.tokenUri === null) throw new Error("tokenURI unavailable")
        return options.tokenUri ?? "data:application/json,%7B%22name%22%3A%22One%22%7D"
      }
      return valueFor(args.functionName)
    },
    multicall: async (args: { allowFailure?: boolean; contracts: { functionName: string; args?: readonly unknown[] }[] }) => {
      if (options.fail) throw new Error("fixture RPC failure")
      return args.contracts.map(({ functionName, args: callArgs }) => {
        try {
          if (functionName === "collection" && options.compatibleMinter === false) {
            return args.allowFailure ? { status: "failure", error: new Error("wrong collection") } : undefined
          }
          const result = valueFor(functionName, callArgs)
          return args.allowFailure ? { status: "success", result } : result
        } catch (error) {
          if (!args.allowFailure) throw error
          return { status: "failure", error }
        }
      })
    },
  }
}

const releaseRef = { chainId: 1, collection, protocol: "surface@1" as const }

function state(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    release: {
      ...releaseRef,
      owner,
      renderer,
      idMode: IdMode.Sequential,
      primaryMinter: minter,
      validatedAtBlock: 21_000_000n,
    },
    minted: 5n,
    supplyCap: 12n,
    saleMinted: 5n,
    saleSupplyCap: 12n,
    mintStart: 100n,
    mintEnd: 200n,
    price: 100n,
    priceStrategy: "0x0000000000000000000000000000000000000000",
    allowlistRoot: zeroRoot,
    walletCap: 0n,
    mintedByAccount: 0n,
    lifecycle: SurfaceStatus.Open,
    blockNumber: 21_000_000n,
    ...overrides,
  }
}

test("parity gate covers fixed-price provider and releaseAvailability boundaries", async () => {
  const provider = createDirectChainSurfaceProvider({ client: fixtureClient() })
  const validated = await provider.validateRelease(releaseRef)
  assert.equal(validated.status, "available")
  if (validated.status !== "available") return
  const live = await provider.readState(validated.value, account)
  assert.equal(live.status, "available")
  if (live.status !== "available") return
  assert.equal(releaseAvailability(live.value, 150).mintable, true)
  assert.equal(releaseAvailability(state(), 99).lifecycle, SurfaceStatus.Scheduled)
  assert.equal(releaseAvailability(state(), 200).lifecycle, SurfaceStatus.Closed)
  assert.equal(releaseAvailability(state({ supplyCap: 5n, minted: 5n }), 150).soldOut, true)
  assert.equal(releaseAvailability(state({ saleSupplyCap: 5n, saleMinted: 5n }), 150).soldOut, true)
})

test("parity gate fails closed for allowlist, wallet cap, and invalid quantity", () => {
  const gated = state({ allowlistRoot: root })
  assert.equal(releaseAvailability(gated, 150).allowlistSatisfied, false)
  assert.equal(releaseAvailability(gated, 150).mintable, false)
  assert.equal(releaseAvailability(gated, 150, { allowlistProofAvailable: true }).mintable, true)
  assert.equal(releaseAvailability(state({ walletCap: 2n, mintedByAccount: 2n }), 150).walletCapped, true)
  assert.equal(releaseAvailability(state(), 150, { quantity: 0n }).quantityValid, false)
})

test("parity gate rejects changed or incompatible minters and RPC failure", async () => {
  const incompatible = createDirectChainSurfaceProvider({ client: fixtureClient({ compatibleMinter: false }) })
  const validated = await incompatible.validateRelease(releaseRef)
  assert.equal(validated.status, "available")
  if (validated.status !== "available") return
  assert.equal((await incompatible.readState(validated.value, account)).status, "unsupported")

  const failed = createDirectChainSurfaceProvider({ client: fixtureClient({ fail: true }) })
  assert.equal((await failed.validateRelease(releaseRef)).status, "unavailable")
})

test("parity gate preserves tokenURI partial state", async () => {
  const provider = createDirectChainSurfaceProvider({ client: fixtureClient({ tokenUri: null }) })
  const validated = await provider.validateRelease(releaseRef)
  assert.equal(validated.status, "available")
  if (validated.status !== "available") return
  const token = await provider.readToken({ release: validated.value, tokenId: 1n })
  assert.equal(token.status, "partial")
  if (token.status === "partial") assert.deepEqual(token.missing, ["tokenUri"])
})

test("parity gate keeps Homage behavior on its explicit adapter", async () => {
  const homageTarget = "0x8888888888888888888888888888888888888888" as Address
  const adapter: SurfaceMintAdapter = {
    id: "homage.fixture@1",
    async readState(_context, release) {
      return { status: "available", value: { ...state(), release, price: 42n, priceStrategy: homageTarget, lifecycle: SurfaceStatus.Open }, evidence: { truth: "protocol", source: this.id } }
    },
    async quoteMint(_context, input) {
      return { status: "available", value: { quantity: input.quantity, unitPrice: 42n, totalValue: 42n, referrer: input.referrer, quotedAtBlock: 21_000_000n }, evidence: { truth: "protocol", source: this.id } }
    },
    prepareMint(input) {
      return { status: "available", value: { chainId: 1, target: homageTarget, abi: [], functionName: "mintHomage", args: [input.account, input.selection], value: input.quote.totalValue, effects: ["homage-mint"] }, evidence: { truth: "protocol", source: this.id } }
    },
  }
  const provider = createDirectChainSurfaceProvider({ client: fixtureClient({ compatibleMinter: false }), mintAdapter: adapter })
  const validated = await provider.validateRelease(releaseRef)
  assert.equal(validated.status, "available")
  if (validated.status !== "available") return
  const release = { ...validated.value, idMode: IdMode.Pooled }
  const quote = await provider.quoteMint({ release, account, quantity: 1n, referrer: owner, selection: { punkId: 111n } })
  assert.equal(quote.status, "available")
  if (quote.status !== "available") return
  const prepared = await provider.prepareMint({ release, account, quantity: 1n, referrer: owner, selection: { punkId: 111n }, quote: quote.value })
  assert.equal(prepared.status, "available")
  if (prepared.status === "available") assert.equal(prepared.value.functionName, "mintHomage")
})
