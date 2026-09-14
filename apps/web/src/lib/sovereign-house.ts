/**
 * Resolver for an artist's sovereign auction house address.
 *
 * Source of truth: the Ponder indexer's `pnd_houses` table (under the
 * schema named by `INDEXER_SCHEMA`, see lib/indexer-schema.ts). Ponder
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
import { createPublicClient, type Address } from "viem"
import { mainnet } from "viem/chains"
import { sovereignAuctionHouseFactoryAbi } from "@pin/abi"
import {
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"
import { sql } from "./db"
import { getMainnetTransport } from "./alchemy-rpc"
import { INDEXER_SCHEMA } from "./indexer-schema"

const SOVEREIGN_FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  MAINNET_CHAIN_ID,
)
const SOVEREIGN_V2_FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  MAINNET_CHAIN_ID,
)
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: getMainnetTransport(),
  })
}

async function readHouseFromPonder(
  artistLower: string,
): Promise<Address | null | undefined> {
  if (!sql) return undefined
  try {
    const schema = INDEXER_SCHEMA
    // An artist can hold one house per factory generation. Prefer the
    // newest: display reads should point at the V2 house once it exists.
    // Against a pre-version-column schema this query errors and falls
    // through to the on-chain read.
    const rows = (await sql.unsafe(
      `SELECT house FROM ${schema}.pnd_houses
       WHERE lower(owner) = $1
       ORDER BY version DESC
       LIMIT 1`,
      [artistLower],
    )) as Array<{ house: string }>
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
  // V2 factory first (same houseOf ABI), matching the version-DESC
  // preference of the Ponder path. Folds to V1-only while the V2 factory
  // address is unset.
  const factories = [SOVEREIGN_V2_FACTORY, SOVEREIGN_FACTORY].filter(
    (f): f is Address => f !== null,
  )
  for (const factoryAddress of factories) {
    try {
      const house = await getClient().readContract({
        address: factoryAddress,
        abi: sovereignAuctionHouseFactoryAbi,
        functionName: "houseOf",
        args: [artistAddress as Address],
      })
      if (house !== ZERO_ADDRESS) return house
    } catch {
      // Try the next generation's factory.
    }
  }
  return null
}

export const getSovereignHouseOf = unstable_cache(
  async (artistAddress: string): Promise<Address | null> => {
    const lower = artistAddress.toLowerCase()
    const fromPonder = await readHouseFromPonder(lower)
    if (fromPonder !== undefined) return fromPonder
    return readHouseOnChain(artistAddress)
  },
  ["sov-house-v2"],
  // 1h TTL, tag-busted by POST /api/sovereign-house/revalidate right
  // after a house deploy or upgrade confirms (useDeployHouse,
  // HouseUpgradePanel), so the CTA/count don't wait out the TTL.
  { revalidate: 60 * 60, tags: ["sov-house"] },
)
