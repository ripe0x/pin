import "server-only"
import {createPublicClient, http, type Address} from "viem"
import {mainnet, sepolia} from "viem/chains"
import {homageCollectionAbi} from "./contracts"

// Which homage tokens have been minted, by chain enumeration (Transfer from 0x0). Pooled
// collections mint arbitrary ids, so this is the local/fork source of truth; production
// swaps in the indexer. Fork-aware client, mirrors detect.server.ts.
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
 * read failure (the page falls back to the sample field). On the fork the collection was
 * just deployed, so a recent block window covers every mint.
 */
export async function getHomageMintedIds(collection: Address, limit = 24): Promise<number[]> {
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
