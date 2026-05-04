/**
 * Resolver for an artist's sovereign auction house address.
 *
 * Source of truth: the Ponder indexer's `ponder.pnd_houses` table. Ponder
 * subscribes to the factory's `AuctionHouseCreated` events in real time
 * and maintains a row per house indexed by `owner`. Reading from there
 * costs one Postgres point query and is free of on-chain RPC traffic.
 *
 * `houseOf(artist)` on the factory contract is the on-chain fallback —
 * used only when Postgres is unavailable, or when the artist deployed a
 * house in the few seconds between Ponder's poll cycle. Both cases are
 * rare; the fallback exists so the app keeps working under degraded
 * indexer state, not as a regular code path.
 *
 * The L1 `unstable_cache` wrapper dedupes within a single sandbox during
 * a request burst. No L2 needed — Ponder IS the L2.
 *
 * Returns null both when the chain has no factory configured AND when
 * the artist hasn't deployed a house yet. Callers treat the two cases
 * the same.
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
import { sql } from "./db"
import { getAlchemyMainnetUrl } from "./alchemy-rpc"

const SOVEREIGN_FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  MAINNET_CHAIN_ID,
)
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(getAlchemyMainnetUrl()),
  })
}

async function readHouseFromPonder(
  artistLower: string,
): Promise<Address | null | undefined> {
  if (!sql) return undefined
  try {
    const rows = await sql<Array<{ house: string }>>`
      SELECT house FROM ponder.pnd_houses
      WHERE lower(owner) = ${artistLower}
      LIMIT 1
    `
    if (rows.length === 0) return null
    return rows[0].house as Address
  } catch {
    // Ponder schema unavailable (preview deploy without DB, transient
    // pgbouncer hiccup). Treat as "don't know" so the caller falls
    // through to the on-chain read instead of incorrectly reporting no
    // house.
    return undefined
  }
}

async function readHouseOnChain(
  artistAddress: string,
): Promise<Address | null> {
  if (!SOVEREIGN_FACTORY) return null
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
}

export const getSovereignHouseOf = unstable_cache(
  async (artistAddress: string): Promise<Address | null> => {
    const lower = artistAddress.toLowerCase()
    const fromPonder = await readHouseFromPonder(lower)
    if (fromPonder !== undefined) return fromPonder
    return readHouseOnChain(artistAddress)
  },
  ["sov-house-v2"],
  { revalidate: 60 * 60 * 24, tags: ["sov-house"] },
)
