import type { ProviderResult } from "@pin/release-spec"
import { fixedPriceMinterAbi, surfaceAbi, surfaceFactoryAbi } from "@pin/abi"
import type { Address, Hex } from "viem"
import { buildTokenHTML } from "./render/build.ts"
import { extractRevealTokenId } from "./reveal.ts"
import { prepareFixedPriceMint } from "./fixed-price.ts"
import { lifecycleStatus, ZERO_ADDRESS } from "./lifecycle.ts"
import {
  IdMode,
  SurfaceStatus,
  type CoreReleaseProvider,
  type MintQuote,
  type MintQuoteInput,
  type PrepareMintInput,
  type PreparedTransaction,
  type ReleaseRef,
  type ReleaseState,
  type ValidatedRelease,
} from "./types.ts"

const ZERO_ROOT = `0x${"0".repeat(64)}` as Hex

type RawSurfaceConfig = {
  supplyCap: bigint
  royaltyBps: number
  royaltyReceiver: Address
  renderer: Address
  rendererLocked: boolean
  supplyLocked: boolean
}

type Available<T> = Extract<ProviderResult<T>, { status: "available" | "partial" }>

export type DirectChainContext = {
  client: DirectChainClient
  source: string
}

/** The narrow viem-compatible surface the core needs. Transport and RPC URLs stay injected. */
export type DirectChainClient = {
  chain?: { id: number }
  getBlockNumber: (...args: any[]) => Promise<bigint>
  readContract: (...args: any[]) => Promise<unknown>
  multicall: (...args: any[]) => Promise<readonly any[]>
}

export interface SurfaceMintAdapter {
  readonly id: string
  readState(
    context: DirectChainContext,
    release: ValidatedRelease,
    account?: Address,
    signal?: AbortSignal,
  ): Promise<ProviderResult<ReleaseState>>
  quoteMint(
    context: DirectChainContext,
    input: MintQuoteInput,
    signal?: AbortSignal,
  ): Promise<ProviderResult<MintQuote>>
  prepareMint(input: PrepareMintInput): ProviderResult<PreparedTransaction>
}

export type DirectChainProviderOptions = {
  client: DirectChainClient
  source?: string
  mintAdapter?: SurfaceMintAdapter
}

function unavailable(reason: string, retryable = true): ProviderResult<never> {
  return { status: "unavailable", reason, retryable }
}

function unsupported(reason: string): ProviderResult<never> {
  return { status: "unsupported", reason }
}

function evidence(source: string, blockNumber: bigint) {
  return {
    truth: "protocol" as const,
    source,
    observedAt: new Date().toISOString(),
    blockNumber: blockNumber.toString(),
  }
}

function abortIfRequested(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

function successful<T>(result: { status: string; result?: unknown }): T | undefined {
  return result.status === "success" ? (result.result as T) : undefined
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function allowlistProof(selection: unknown): readonly Hex[] | undefined {
  if (!selection || typeof selection !== "object") return undefined
  const proof = (selection as { allowlistProof?: unknown }).allowlistProof
  return Array.isArray(proof) && proof.every((value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value))
    ? proof as readonly Hex[]
    : undefined
}

export const fixedPriceMintAdapter: SurfaceMintAdapter = {
  id: "surface.fixed-price@1",

  async readState(context, release, account, signal) {
    abortIfRequested(signal)
    if (!release.primaryMinter) return unsupported("This release has no primary minter")
    const minter = release.primaryMinter
    try {
      const blockNumber = await context.client.getBlockNumber()
      abortIfRequested(signal)
      const recipient = account ?? ZERO_ADDRESS
      const [config, collection, price, priceStrategy, mintStart, mintEnd, maxMints, totalMinted, allowlistRoot, walletCap, referralShareBps, mintedBy] =
        await context.client.multicall({
          allowFailure: true,
          blockNumber,
          contracts: [
            { address: release.collection, abi: surfaceAbi, functionName: "config" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "collection" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "priceOf", args: [recipient, 1n] },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "priceStrategy" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "mintStart" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "mintEnd" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "maxMints" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "totalMinted" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "allowlistRoot" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "walletCap" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "referralShareBps" },
            { address: minter, abi: fixedPriceMinterAbi, functionName: "mintedBy", args: [recipient] },
          ],
        })
      abortIfRequested(signal)
      const linkedCollection = successful<Address>(collection)
      if (!linkedCollection || !sameAddress(linkedCollection, release.collection)) {
        return unsupported("The primary minter is not a compatible FixedPriceMinter for this collection")
      }
      const configValue = successful<readonly [RawSurfaceConfig, bigint]>(config)
      const unitPrice = successful<bigint>(price)
      const strategy = successful<Address>(priceStrategy)
      const starts = successful<bigint>(mintStart)
      const ends = successful<bigint>(mintEnd)
      const saleCap = successful<bigint>(maxMints)
      const saleMinted = successful<bigint>(totalMinted)
      if (!configValue || unitPrice === undefined || strategy === undefined || starts === undefined || ends === undefined || saleCap === undefined || saleMinted === undefined) {
        return unavailable("Current fixed-price release state could not be read")
      }
      const [cfg, minted] = configValue
      const nowSec = Math.floor(Date.now() / 1000)
      let lifecycle = lifecycleStatus({ mintStart: starts, mintEnd: ends, supplyCap: cfg.supplyCap }, minted, nowSec)
      if (saleCap > 0n && saleMinted >= saleCap) lifecycle = SurfaceStatus.Closed
      const value: ReleaseState = {
        release,
        account,
        minted,
        supplyCap: cfg.supplyCap,
        saleMinted,
        saleSupplyCap: saleCap,
        mintStart: starts,
        mintEnd: ends,
        price: unitPrice,
        priceStrategy: strategy,
        allowlistRoot: successful<Hex>(allowlistRoot) ?? ZERO_ROOT,
        walletCap: successful<bigint>(walletCap) ?? 0n,
        mintedByAccount: successful<bigint>(mintedBy) ?? 0n,
        referralShareBps: Number(successful<number>(referralShareBps) ?? 0),
        lifecycle,
        blockNumber,
      }
      const missing = [allowlistRoot, walletCap, referralShareBps, mintedBy]
        .map((item, index) => item.status === "success" ? null : ["allowlistRoot", "walletCap", "referralShareBps", "mintedByAccount"][index])
        .filter((item): item is string => item !== null)
      return missing.length > 0
        ? { status: "partial", value, missing, evidence: evidence(context.source, blockNumber) }
        : { status: "available", value, evidence: evidence(context.source, blockNumber) }
    } catch (error) {
      if (signal?.aborted) throw error
      return unavailable("Current fixed-price release state could not be read")
    }
  },

  async quoteMint(context, input, signal) {
    abortIfRequested(signal)
    if (input.quantity < 1n) return unsupported("Mint quantity must be at least one")
    const minter = input.release.primaryMinter
    if (!minter) return unsupported("This release has no primary minter")
    try {
      const blockNumber = await context.client.getBlockNumber()
      const [totalValue, unitPrice] = await context.client.multicall({
        allowFailure: false,
        blockNumber,
        contracts: [
          {
            address: minter,
            abi: fixedPriceMinterAbi,
            functionName: "priceOf",
            args: [input.account ?? ZERO_ADDRESS, input.quantity],
          },
          {
            address: minter,
            abi: fixedPriceMinterAbi,
            functionName: "priceOf",
            args: [input.account ?? ZERO_ADDRESS, 1n],
          },
        ],
      }) as readonly [bigint, bigint]
      abortIfRequested(signal)
      return {
        status: "available",
        value: {
          quantity: input.quantity,
          unitPrice,
          totalValue,
          referrer: input.referrer,
          quotedAtBlock: blockNumber,
          expiresAfterBlock: blockNumber + 1n,
        },
        evidence: evidence(context.source, blockNumber),
      }
    } catch (error) {
      if (signal?.aborted) throw error
      return unavailable("The current mint price could not be confirmed")
    }
  },

  prepareMint(input) {
    if (!input.release.primaryMinter) return unsupported("This release has no primary minter")
    if (!input.account) return unsupported("A connected recipient is required to prepare a mint")
    if (input.quote.quantity !== input.quantity || !sameAddress(input.quote.referrer, input.referrer)) {
      return unsupported("The mint input no longer matches its quote")
    }
    try {
      return {
        status: "available",
        value: prepareFixedPriceMint({
          chainId: input.release.chainId,
          minter: input.release.primaryMinter,
          recipient: input.account,
          quantity: input.quantity,
          referrer: input.referrer,
          totalValue: input.quote.totalValue,
          allowlistProof: allowlistProof(input.selection),
        }),
        evidence: { truth: "protocol", source: this.id, blockNumber: input.quote.quotedAtBlock.toString() },
      }
    } catch {
      return unsupported("The fixed-price mint transaction could not be prepared")
    }
  },
}

export function createDirectChainSurfaceProvider(options: DirectChainProviderOptions): CoreReleaseProvider {
  const context: DirectChainContext = {
    client: options.client,
    source: options.source ?? `eip155:${options.client.chain?.id ?? "unknown"}:direct`,
  }
  const mintAdapter = options.mintAdapter ?? fixedPriceMintAdapter

  return {
    async validateRelease(ref, signal) {
      abortIfRequested(signal)
      if (options.client.chain && options.client.chain.id !== ref.chainId) {
        return unsupported(`The injected client is connected to chain ${options.client.chain.id}, not ${ref.chainId}`)
      }
      try {
        const blockNumber = await options.client.getBlockNumber()
        if (ref.factory) {
          const member = await options.client.readContract({
            address: ref.factory,
            abi: surfaceFactoryAbi,
            functionName: "isSurface",
            args: [ref.collection],
            blockNumber,
          }) as boolean
          if (!member) return unsupported("The collection is not registered by the declared Surface factory")
        }
        const [owner, config, idMode, primaryMinter] = await options.client.multicall({
          allowFailure: false,
          blockNumber,
          contracts: [
            { address: ref.collection, abi: surfaceAbi, functionName: "owner" },
            { address: ref.collection, abi: surfaceAbi, functionName: "config" },
            { address: ref.collection, abi: surfaceAbi, functionName: "idMode" },
            { address: ref.collection, abi: surfaceAbi, functionName: "primaryMinter" },
          ],
        })
        abortIfRequested(signal)
        const [cfg] = config as readonly [RawSurfaceConfig, bigint]
        const rawMinter = primaryMinter as Address
        const mode = Number(idMode)
        if (mode !== IdMode.Sequential && mode !== IdMode.Pooled) {
          return unsupported(`Unknown Surface id mode: ${mode}`)
        }
        return {
          status: "available",
          value: {
            ...ref,
            owner: owner as Address,
            renderer: cfg.renderer,
            idMode: mode,
            primaryMinter: sameAddress(rawMinter, ZERO_ADDRESS) ? null : rawMinter,
            validatedAtBlock: blockNumber,
          },
          evidence: evidence(context.source, blockNumber),
        }
      } catch (error) {
        if (signal?.aborted) throw error
        return unavailable("The collection could not be validated as a compatible Surface release")
      }
    },

    readState(release, account, signal) {
      return mintAdapter.readState(context, release, account, signal)
    },

    quoteMint(input, signal) {
      return mintAdapter.quoteMint(context, input, signal)
    },

    async prepareMint(input) {
      return mintAdapter.prepareMint(input)
    },

    async readToken(input, signal) {
      abortIfRequested(signal)
      try {
        const blockNumber = await options.client.getBlockNumber()
        const [owner, seed] = await options.client.multicall({
          allowFailure: true,
          blockNumber,
          contracts: [
            { address: input.release.collection, abi: surfaceAbi, functionName: "ownerOf", args: [input.tokenId] },
            { address: input.release.collection, abi: surfaceAbi, functionName: "tokenSeed", args: [input.tokenId] },
          ],
        })
        const tokenSeed = successful<Hex>(seed)
        if (!tokenSeed) return unsupported("This token has never been minted")
        const tokenUri = await options.client.readContract({
          address: input.release.collection,
          abi: surfaceAbi,
          functionName: "tokenURI",
          args: [input.tokenId],
          blockNumber,
        }).then((value) => value as string).catch(() => null)
        abortIfRequested(signal)
        const value = {
          tokenId: input.tokenId,
          owner: successful<Address>(owner) ?? null,
          seed: tokenSeed,
          tokenUri,
          blockNumber,
        }
        return tokenUri === null
          ? { status: "partial", value, missing: ["tokenUri"], evidence: evidence(context.source, blockNumber) }
          : { status: "available", value, evidence: evidence(context.source, blockNumber) }
      } catch (error) {
        if (signal?.aborted) throw error
        return unavailable("The token could not be read")
      }
    },

    async prepareRender(input, signal) {
      abortIfRequested(signal)
      try {
        const document = await buildTokenHTML(input.work, input.tokenData, input.resolver, input.options)
        abortIfRequested(signal)
        return {
          status: "available",
          value: { mediaType: "text/html", document },
          evidence: { truth: "protocol", source: "surface-render@1" },
        }
      } catch (error) {
        if (signal?.aborted) throw error
        return unavailable("The renderer dependencies could not be assembled")
      }
    },

    async resolveReveal(input, signal) {
      abortIfRequested(signal)
      return {
        status: "available",
        value: {
          tokenId: extractRevealTokenId({
            reveal: input.source,
            logs: input.logs,
            collection: input.collection,
            abi: input.abi,
            minter: input.minter,
          }),
        },
        evidence: { truth: "protocol", source: "transaction-receipt" },
      }
    },
  }
}

export function providerValue<T>(result: ProviderResult<T>): T | undefined {
  return result.status === "available" || result.status === "partial" ? result.value : undefined
}
