import "server-only"
import {createPublicClient, http, type Address} from "viem"
import {mainnet, sepolia} from "viem/chains"
import {homageCollectionAbi} from "./contracts"
import {
  getCollectionMintFeedFromIndexer,
  getCollectionMintedIdsFromIndexer,
  type IndexedCollectionMint,
} from "@/lib/indexer-queries"

// Which homage tokens have been minted. Production source is the indexer
// (ponder collection_tokens/collection_mints — homage is a factory clone, so
// Surface:Minted/Burned keep those tables current); the Transfer(from=0x0)
// chain enumeration below is the fork/sepolia path and the fallback when the
// indexer is unavailable. Fork-aware client, mirrors detect.server.ts.
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Opt-in sepolia instance (mirrors mint-collections.ts' MINT_CHAIN_ID split).
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"
const SEPOLIA_RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
const ZERO = "0x0000000000000000000000000000000000000000" as const

function getClient() {
  if (FORK_MODE) {
    const url = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"
    return createPublicClient({chain: mainnet, transport: http(url)})
  }
  if (USE_SEPOLIA) return createPublicClient({chain: sepolia, transport: http(SEPOLIA_RPC_URL)})
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return createPublicClient({chain: mainnet, transport: http(explicit)})
  const key = process.env.ALCHEMY_API_KEY
  const url =
    key && !key.startsWith("set-")
      ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
      : "https://eth.drpc.org"
  return createPublicClient({chain: mainnet, transport: http(url)})
}

/**
 * The homage collection's minted token ids, newest first, capped at `limit`. Empty on any
 * read failure (the page falls back to the sample field). Indexer-first (one SELECT, no
 * RPC); the chain scan below covers fork/sepolia and indexer downtime. On the fork the
 * collection was just deployed, so a recent block window covers every mint.
 */
export async function getHomageMintedIds(collection: Address, limit = 24): Promise<number[]> {
  if (!FORK_MODE && !USE_SEPOLIA) {
    const indexed = await getCollectionMintedIdsFromIndexer(collection, limit)
    if (indexed !== null) return indexed
  }
  try {
    const client = getClient()
    const latest = await client.getBlockNumber()
    const span = 300_000n
    const fromBlock = latest > span ? latest - span : 0n
    const logs = await client.getContractEvents({
      address: collection,
      abi: homageCollectionAbi,
      eventName: "Transfer",
      args: {from: ZERO},
      fromBlock,
      toBlock: "latest",
    })
    const ids: number[] = []
    const seen = new Set<number>()
    // newest first
    for (let i = logs.length - 1; i >= 0 && ids.length < limit; i--) {
      const id = (logs[i].args as {tokenId?: bigint}).tokenId
      if (id === undefined) continue
      const n = Number(id)
      if (!seen.has(n)) {
        seen.add(n)
        ids.push(n)
      }
    }
    return ids
  } catch {
    return []
  }
}

export type HomageMintEntry = {
  tokenId: number
  to: `0x${string}`
  txHash: `0x${string}`
  /** Mint block's unix seconds. Always set on the indexer path (block_time
   *  is on the row); on the chain-scan fallback it comes from one getBlock
   *  per unique block among the visible rows. */
  timestamp?: number
}

/**
 * Recent homage mints, newest first, one entry per token — the mint-history
 * feed the collection page passes to HomageMintLog. Indexer-first (one
 * SELECT over collection_mints; a Minted row's [firstTokenId, +quantity)
 * range expands here, though homage always mints quantity 1); the
 * Transfer(from=0x0) chain scan is the fork/sepolia path and the fallback
 * when the indexer is unavailable — previously this exact scan ran in every
 * visitor's browser.
 */
export async function getHomageMintFeed(collection: Address, limit = 12): Promise<HomageMintEntry[]> {
  if (!FORK_MODE && !USE_SEPOLIA) {
    const indexed = await getCollectionMintFeedFromIndexer(collection, limit)
    if (indexed !== null) {
      const entries: HomageMintEntry[] = []
      for (const m of indexed as IndexedCollectionMint[]) {
        // Newest token of a multi-mint range first, matching block order.
        for (let i = m.quantity - 1; i >= 0 && entries.length < limit; i--) {
          entries.push({
            tokenId: m.firstTokenId + i,
            to: m.to as `0x${string}`,
            txHash: m.txHash as `0x${string}`,
            timestamp: m.blockTime,
          })
        }
        if (entries.length >= limit) break
      }
      return entries
    }
  }
  try {
    const client = getClient()
    const latest = await client.getBlockNumber()
    const span = 300_000n
    const fromBlock = latest > span ? latest - span : 0n
    const logs = await client.getContractEvents({
      address: collection,
      abi: homageCollectionAbi,
      eventName: "Transfer",
      args: {from: ZERO},
      fromBlock,
      toBlock: "latest",
    })
    const entries: HomageMintEntry[] = []
    const blockOf = new Map<number, bigint>()
    const seen = new Set<number>()
    for (let i = logs.length - 1; i >= 0 && entries.length < limit; i--) {
      const {tokenId, to} = logs[i].args as {tokenId?: bigint; to?: string}
      const bn = logs[i].blockNumber
      if (tokenId === undefined || to === undefined || !logs[i].transactionHash || bn === null) continue
      const n = Number(tokenId)
      if (seen.has(n)) continue
      seen.add(n)
      blockOf.set(n, bn)
      entries.push({tokenId: n, to: to as `0x${string}`, txHash: logs[i].transactionHash as `0x${string}`})
    }
    // Timestamps aren't in the Transfer log — one getBlock per unique block
    // among the visible rows (batch mints share blocks).
    const uniqueBlocks = Array.from(new Set(blockOf.values()))
    const blocks = await Promise.all(
      uniqueBlocks.map((bn) => client.getBlock({blockNumber: bn}).catch(() => null)),
    )
    const tsByBlock = new Map<bigint, number>()
    uniqueBlocks.forEach((bn, i) => {
      const b = blocks[i]
      if (b) tsByBlock.set(bn, Number(b.timestamp))
    })
    return entries.map((e) => {
      const bn = blockOf.get(e.tokenId)
      return bn !== undefined ? {...e, timestamp: tsByBlock.get(bn)} : e
    })
  } catch {
    return []
  }
}
