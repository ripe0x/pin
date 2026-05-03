/**
 * Cached resolver for an artist's sovereign auction house address.
 *
 * `houseOf(artist)` is a stable read — once an artist deploys a house, its
 * address never changes. Callers in last-sale and active-auction-count
 * paths fire it on every cache miss, so without a dedicated cache we
 * pay one `eth_call` per (artist, render) pair across the whole site.
 *
 * Two layers, same shape as the rest of the codebase:
 *   - `unstable_cache` (L1, in-process) for hot single-sandbox paths
 *   - `pgCache` (L2, shared Postgres) for cold-start fan-out across sandboxes
 *
 * Returns null both when the chain has no factory configured AND when the
 * artist hasn't deployed a house yet. Callers treat the two cases the
 * same. TTL is 24h: long enough to amortize, short enough that a
 * just-deployed house surfaces within a day without a manual revalidate.
 */
import { unstable_cache } from "next/cache"
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { sovereignAuctionHouseFactoryAbi } from "@pin/abi"
import {
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"
import { pgCache } from "./pg-cache"

const SOVEREIGN_FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  MAINNET_CHAIN_ID,
)
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com",
    ),
  })
}

const TTL_SECONDS = 60 * 60 * 24

export const getSovereignHouseOf = unstable_cache(
  async (artistAddress: string): Promise<Address | null> => {
    if (!SOVEREIGN_FACTORY) return null
    const lower = artistAddress.toLowerCase()
    const result = await pgCache<string | null>(
      `sov-house:${lower}`,
      TTL_SECONDS,
      async () => {
        try {
          const house = await getClient().readContract({
            address: SOVEREIGN_FACTORY,
            abi: sovereignAuctionHouseFactoryAbi,
            functionName: "houseOf",
            args: [artistAddress as Address],
          })
          return house === ZERO_ADDRESS ? null : house
        } catch {
          return null
        }
      },
    )
    return result as Address | null
  },
  ["sov-house"],
  { revalidate: TTL_SECONDS, tags: ["sov-house"] },
)
