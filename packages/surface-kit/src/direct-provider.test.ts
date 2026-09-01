import assert from "node:assert/strict"
import test from "node:test"
import type { ProviderResult } from "@pin/release-spec"
import type { Address, PublicClient } from "viem"
import {
  IdMode,
  SurfaceStatus,
  createDirectChainSurfaceProvider,
  type DirectChainContext,
  type MintQuote,
  type MintQuoteInput,
  type PrepareMintInput,
  type PreparedTransaction,
  type ReleaseState,
  type SurfaceMintAdapter,
  type ValidatedRelease,
} from "./index.ts"

const collection = "0x1111111111111111111111111111111111111111" as Address
const owner = "0x2222222222222222222222222222222222222222" as Address
const minter = "0x3333333333333333333333333333333333333333" as Address
const renderer = "0x4444444444444444444444444444444444444444" as Address
const account = "0x5555555555555555555555555555555555555555" as Address
const referrer = "0x6666666666666666666666666666666666666666" as Address
const factory = "0x7777777777777777777777777777777777777777" as Address
const seed = `0x${"12".repeat(32)}` as const
const root = `0x${"00".repeat(32)}` as const

function resultFor(functionName: string, args?: readonly unknown[]): unknown {
  switch (functionName) {
    case "owner": return owner
    case "config": return [{
      supplyCap: 12n,
      royaltyBps: 1000,
      royaltyReceiver: owner,
      renderer,
      rendererLocked: true,
      supplyLocked: true,
    }, 5n] as const
    case "idMode": return 0
    case "primaryMinter": return minter
    case "collection": return collection
    case "priceOf": return 100_000_000_000_000_000n * BigInt(args?.[1] as bigint ?? 1n)
    case "priceStrategy": return "0x0000000000000000000000000000000000000000"
    case "mintStart": return 0n
    case "mintEnd": return 0n
    case "maxMints": return 12n
    case "totalMinted": return 5n
    case "allowlistRoot": return root
    case "walletCap": return 0n
    case "referralShareBps": return 1000
    case "mintedBy": return 1n
    case "ownerOf": return account
    case "tokenSeed": return seed
    default: throw new Error(`unexpected read ${functionName}`)
  }
}

function fixtureClient(options: { compatibleMinter?: boolean } = {}): PublicClient {
  return {
    chain: { id: 1 },
    getBlockNumber: async () => 21_000_000n,
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === "isSurface") return true
      if (args.functionName === "tokenURI") return "data:application/json,%7B%22name%22%3A%22One%22%7D"
      return resultFor(args.functionName, (args as { args?: readonly unknown[] }).args)
    },
    multicall: async (args: { allowFailure?: boolean; contracts: { functionName: string; args?: readonly unknown[] }[] }) => {
      if (args.allowFailure) {
        return args.contracts.map(({ functionName, args: callArgs }) =>
          functionName === "collection" && options.compatibleMinter === false
            ? { status: "failure", error: new Error("custom minter") }
            : { status: "success", result: resultFor(functionName, callArgs) },
        )
      }
      return args.contracts.map(({ functionName, args: callArgs }) => resultFor(functionName, callArgs))
    },
  } as unknown as PublicClient
}

const releaseRef = { chainId: 1, collection, protocol: "surface@1" as const, factory }

function available<T>(result: ProviderResult<T>): T {
  assert.ok(result.status === "available" || result.status === "partial")
  return result.value
}

test("sequential fixed-price provider keeps validation, state, quote, transaction, and token reads on one boundary", async () => {
  const provider = createDirectChainSurfaceProvider({ client: fixtureClient(), source: "fixture-rpc" })
  const release = available(await provider.validateRelease(releaseRef))
  assert.equal(release.idMode, IdMode.Sequential)
  assert.equal(release.primaryMinter, minter)

  const state = available(await provider.readState(release, account))
  assert.equal(state.lifecycle, SurfaceStatus.Open)
  assert.equal(state.minted, 5n)
  assert.equal(state.saleMinted, 5n)
  assert.equal(state.price, 100_000_000_000_000_000n)

  const quote = available(await provider.quoteMint({
    release,
    account,
    quantity: 2n,
    referrer,
  }))
  assert.equal(quote.unitPrice, 100_000_000_000_000_000n)
  assert.equal(quote.totalValue, 200_000_000_000_000_000n)
  const transaction = available(await provider.prepareMint({
    release,
    account,
    quantity: 2n,
    referrer,
    quote,
  }))
  assert.equal(transaction.target, minter)
  assert.deepEqual(transaction.args.slice(0, 3), [account, 2n, referrer])
  assert.equal(transaction.value, quote.totalValue)

  const token = available(await provider.readToken({ release, tokenId: 1n }))
  assert.equal(token.owner, account)
  assert.equal(token.seed, seed)
  assert.match(token.tokenUri ?? "", /^data:application\/json/)
})

test("the generic adapter rejects a custom minter and an explicit Homage fixture owns its behavior", async () => {
  const validated: ValidatedRelease = {
    ...releaseRef,
    owner,
    renderer,
    idMode: IdMode.Pooled,
    primaryMinter: minter,
    validatedAtBlock: 21_000_000n,
  }
  const generic = createDirectChainSurfaceProvider({ client: fixtureClient({ compatibleMinter: false }) })
  const genericState = await generic.readState(validated, account)
  assert.equal(genericState.status, "unsupported")

  const homageTarget = "0x8888888888888888888888888888888888888888" as Address
  const homageAdapter: SurfaceMintAdapter = {
    id: "homage.fixture@1",
    async readState(_context: DirectChainContext, release: ValidatedRelease): Promise<ProviderResult<ReleaseState>> {
      return {
        status: "available",
        value: {
          release,
          minted: 5n,
          supplyCap: 10_000n,
          mintStart: 0n,
          mintEnd: 0n,
          price: 42n,
          priceStrategy: homageTarget,
          lifecycle: SurfaceStatus.Open,
          blockNumber: 21_000_000n,
        },
        evidence: { truth: "protocol", source: this.id },
      }
    },
    async quoteMint(_context: DirectChainContext, input: MintQuoteInput): Promise<ProviderResult<MintQuote>> {
      return {
        status: "available",
        value: {
          quantity: input.quantity,
          unitPrice: 42n,
          totalValue: 42n,
          referrer: input.referrer,
          quotedAtBlock: 21_000_000n,
        },
        evidence: { truth: "protocol", source: this.id },
      }
    },
    prepareMint(input: PrepareMintInput): ProviderResult<PreparedTransaction> {
      return {
        status: "available",
        value: {
          chainId: input.release.chainId,
          target: homageTarget,
          abi: [],
          functionName: "mintHomage",
          args: [input.account, input.selection],
          value: input.quote.totalValue,
          effects: ["homage-mint", "referral"],
        },
        evidence: { truth: "protocol", source: this.id },
      }
    },
  }
  const custom = createDirectChainSurfaceProvider({
    client: fixtureClient({ compatibleMinter: false }),
    mintAdapter: homageAdapter,
  })
  const state = available(await custom.readState(validated, account))
  assert.equal(state.price, 42n)
  const quote = available(await custom.quoteMint({ release: validated, account, quantity: 1n, referrer }))
  const transaction = available(await custom.prepareMint({
    release: validated,
    account,
    quantity: 1n,
    referrer,
    selection: { punkId: 111n },
    quote,
  }))
  assert.equal(transaction.functionName, "mintHomage")
  assert.equal(transaction.target, homageTarget)
})
