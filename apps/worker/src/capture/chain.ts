/**
 * viem reads/writes for the capture tool. Separate from the shared
 * apps/worker/src/rpc.ts client: that client is a mainnet-only multi-provider
 * fallback tuned for the worker's continuous long-tail scanning. This tool
 * is a one-off batch against a single explicit CAPTURE_RPC_URL on a
 * caller-chosen chain (sepolia or mainnet), so it gets its own minimal
 * client instead of forcing sepolia support into the shared one.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { mainnet, sepolia } from "viem/chains"
import { surfaceAbi } from "@pin/abi"
import type { CaptureEnv } from "./config.ts"

const SEQUENTIAL_ID_MODE = 0

/**
 * Local ABI for the RenderAssets capture surface. @pin/abi's generated
 * renderAssetsAbi (packages/abi/src/renderAssets.ts) predates the
 * maxTokenId coverage bound added to RenderAssets.sol: setCaptureTemplate
 * gained a third argument, CaptureTemplateSet gained maxTokenId, and
 * templateMaxTokenIdOf was added. Regenerate that package and drop this
 * once it catches up.
 */
const captureAbi = parseAbi([
  "function setCaptureTemplate(address collection, string template, uint256 maxTokenId)",
  "function templateOf(address collection) view returns (string)",
  "function templateMaxTokenIdOf(address collection) view returns (uint256)",
  "function coverOf(address collection) view returns (string)",
  "function imageFor(address collection, uint256 tokenId) view returns (string)",
])

type ChainEndpoint = Pick<CaptureEnv, "chain" | "rpcUrl">

export function chainFor(env: Pick<CaptureEnv, "chain">): Chain {
  return env.chain === "mainnet" ? mainnet : sepolia
}

export function makePublicClient(env: ChainEndpoint): PublicClient {
  return createPublicClient({ chain: chainFor(env), transport: http(env.rpcUrl) })
}

export function makeWalletClient(env: ChainEndpoint, privateKey: `0x${string}`): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: chainFor(env),
    transport: http(env.rpcUrl),
  })
}

export interface DiscoveredToken {
  tokenId: number
  seed: `0x${string}`
  owner: Address
}

/**
 * Reads config().minted and idMode(), then every live token's seed + owner
 * in one multicall. Sequential ids run 1..minted in mint order; a pooled
 * collection's ids aren't contiguous, so it's rejected rather than guessed
 * at. A token that reverts (e.g. burned) is skipped, not fatal to the batch.
 */
export async function discoverTokens(
  client: PublicClient,
  collection: Address,
): Promise<{ minted: number; tokens: DiscoveredToken[] }> {
  const [idMode, configResult] = await Promise.all([
    client.readContract({ address: collection, abi: surfaceAbi, functionName: "idMode" }),
    client.readContract({ address: collection, abi: surfaceAbi, functionName: "config" }),
  ])
  if (Number(idMode) !== SEQUENTIAL_ID_MODE) {
    throw new Error(
      `collection ${collection} is not Sequential id mode (idMode=${idMode}); ` +
        "this tool only supports sequential collections",
    )
  }
  const minted = Number((configResult as readonly [unknown, bigint])[1])
  if (minted === 0) return { minted, tokens: [] }

  const ids = Array.from({ length: minted }, (_, i) => i + 1)
  const results = await client.multicall({
    contracts: ids.flatMap((tokenId) => [
      { address: collection, abi: surfaceAbi, functionName: "tokenSeed", args: [BigInt(tokenId)] } as const,
      { address: collection, abi: surfaceAbi, functionName: "ownerOf", args: [BigInt(tokenId)] } as const,
    ]),
    allowFailure: true,
  })

  const tokens: DiscoveredToken[] = []
  for (let i = 0; i < ids.length; i++) {
    const seedResult = results[i * 2]
    const ownerResult = results[i * 2 + 1]
    if (seedResult.status !== "success" || ownerResult.status !== "success") {
      console.warn(`[capture-thumbnails] token ${ids[i]} unreadable (burned?), skipping`)
      continue
    }
    tokens.push({
      tokenId: ids[i],
      seed: seedResult.result as `0x${string}`,
      owner: ownerResult.result as Address,
    })
  }
  return { minted, tokens }
}

export async function writeCaptureTemplate(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: { renderAssets: Address; collection: Address },
  template: string,
  maxTokenId: number,
): Promise<{ txHash: `0x${string}` }> {
  const account = wallet.account
  if (!account) throw new Error("wallet client has no account")
  const { request } = await publicClient.simulateContract({
    address: params.renderAssets,
    abi: captureAbi,
    functionName: "setCaptureTemplate",
    args: [params.collection, template, BigInt(maxTokenId)],
    account,
    chain: wallet.chain,
  })
  const txHash = await wallet.writeContract(request)
  await publicClient.waitForTransactionReceipt({ hash: txHash })
  return { txHash }
}

/** Current onchain coverage bound for `refresh`'s default `--to`. */
export async function readTemplateMaxTokenId(
  client: PublicClient,
  params: { renderAssets: Address; collection: Address },
): Promise<bigint> {
  return client.readContract({
    address: params.renderAssets,
    abi: captureAbi,
    functionName: "templateMaxTokenIdOf",
    args: [params.collection],
  })
}

/** Reads back templateOf, templateMaxTokenIdOf, and imageFor at the bound
 *  and one past it, for the readback the run prints right after the write. */
export async function readCaptureState(
  client: PublicClient,
  params: { renderAssets: Address; collection: Address },
  bound: number,
): Promise<{ template: string; maxTokenId: bigint; imageForBound: string; imageForBeyondBound: string }> {
  const [template, maxTokenId, imageForBound, imageForBeyondBound] = await Promise.all([
    client.readContract({ address: params.renderAssets, abi: captureAbi, functionName: "templateOf", args: [params.collection] }),
    client.readContract({ address: params.renderAssets, abi: captureAbi, functionName: "templateMaxTokenIdOf", args: [params.collection] }),
    client.readContract({ address: params.renderAssets, abi: captureAbi, functionName: "imageFor", args: [params.collection, BigInt(bound)] }),
    client.readContract({ address: params.renderAssets, abi: captureAbi, functionName: "imageFor", args: [params.collection, BigInt(bound + 1)] }),
  ])
  return { template, maxTokenId, imageForBound, imageForBeyondBound }
}

/**
 * notifyMetadataUpdate's auth is the collection's renderer, owner, or admin
 * (SurfaceCore.sol notifyMetadataUpdate). The capturer key is normally none
 * of those, so this simulates first and logs a warning instead of failing
 * the run when the call would revert.
 */
export async function tryNotifyMetadataUpdate(
  wallet: WalletClient,
  publicClient: PublicClient,
  collection: Address,
  fromTokenId: number,
  toTokenId: number,
): Promise<{ sent: boolean; txHash?: `0x${string}` }> {
  const account = wallet.account
  if (!account) throw new Error("wallet client has no account")

  let request: Parameters<WalletClient["writeContract"]>[0]
  try {
    ;({ request } = await publicClient.simulateContract({
      address: collection,
      abi: surfaceAbi,
      functionName: "notifyMetadataUpdate",
      args: [BigInt(fromTokenId), BigInt(toTokenId)],
      account,
      chain: wallet.chain,
    }))
  } catch (err) {
    console.warn(
      "[capture-thumbnails] notifyMetadataUpdate would revert: auth is the collection's " +
        `renderer, owner, or admin (SurfaceCore.sol). ${(err as Error).message}`,
    )
    return { sent: false }
  }

  try {
    const txHash = await wallet.writeContract(request)
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    return { sent: true, txHash }
  } catch (err) {
    console.warn(
      "[capture-thumbnails] notifyMetadataUpdate simulated successfully but the broadcast or " +
        `receipt failed: ${(err as Error).message}`,
    )
    return { sent: false }
  }
}
