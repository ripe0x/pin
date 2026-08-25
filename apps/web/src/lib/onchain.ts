import "server-only"
import { createPublicClient, type Address } from "viem"
import { mainnet } from "viem/chains"
import { sovereignAuctionHouseAbi, sovereignAuctionHouseV2Abi } from "@pin/abi"
import { pgCache } from "./pg-cache"
import { getMainnetTransport } from "./alchemy-rpc"
import { sql } from "./db"

/**
 * The ONLY surface in v2 where the web app reaches to chain. Six
 * functions, each pgCache-wrapped, each used by a specific user-facing
 * surface that needs sub-30s freshness.
 *
 * Everything else reads from `lib/reads.ts`.
 *
 * Cost ceiling: at ~100 visits/day with crawler gating, the combined
 * upstream call volume from this module is in the low hundreds per day.
 * The worker's bulk-scan budget dwarfs it.
 */

function getClient() {
  // Tenderly-first public ladder, Alchemy only as a configured backstop —
  // see alchemy-rpc.ts. A single provider's cap/outage rotates to the next
  // rather than 500-ing these user-facing reads.
  return createPublicClient({ chain: mainnet, transport: getMainnetTransport() })
}

/**
 * Current bid amount + end time for a specific Sovereign auction. Used
 * by the live AuctionPanel — the indexer is at most 5 minutes behind
 * head; this read is fresh.
 */
export async function getActiveAuctionState(
  house: Address,
  auctionId: bigint,
): Promise<{ amount: bigint; endTime: bigint } | null> {
  return pgCache(
    `live-auction:${house.toLowerCase()}:${auctionId}`,
    30,
    async () => {
      const client = getClient()
      const isV2 = await client.readContract({
        address: house,
        abi: [{
          type: "function",
          name: "auctionVersion",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint8" }],
        }],
        functionName: "auctionVersion",
      }).then((version) => version === 2).catch(() => false)
      const data = await client.readContract({
        address: house,
        abi: isV2 ? sovereignAuctionHouseV2Abi : sovereignAuctionHouseAbi,
        functionName: "auctions",
        args: [auctionId],
      })
      const tuple = data as unknown as readonly [
        bigint,
        Address,
        bigint,
        bigint,
        bigint,
        Address,
        bigint,
        Address,
        bigint,
      ]
      const amount = tuple[3]
      const endTime = isV2
        ? (tuple as unknown as readonly [bigint, Address, bigint, bigint, bigint, Address, Address, bigint])[7]
        : tuple[6]
      return { amount, endTime }
    },
  )
}

/**
 * Current buy-now price for a Foundation token. Most recent set wins;
 * cleared on cancel/accept. Read fresh because price changes don't have
 * a separate cache-invalidation hook in v2.
 */
export async function getBuyPrice(
  marketContract: Address,
  nftContract: Address,
  tokenId: bigint,
): Promise<{ seller: string; price: bigint } | null> {
  return pgCache(
    `buy-price:${nftContract.toLowerCase()}:${tokenId.toString()}`,
    30,
    async () => {
      const client = getClient()
      try {
        const data = await client.readContract({
          address: marketContract,
          abi: [{
            type: "function", name: "getBuyPrice", stateMutability: "view",
            inputs: [
              { name: "nftContract", type: "address" },
              { name: "tokenId", type: "uint256" },
            ],
            outputs: [
              { name: "seller", type: "address" },
              { name: "price", type: "uint256" },
            ],
          }],
          functionName: "getBuyPrice",
          args: [nftContract, tokenId],
        })
        const [seller, price] = data as unknown as readonly [string, bigint]
        return { seller, price }
      } catch {
        return null
      }
    },
  )
}

/**
 * Map of active SR V2 auctions for an artist, keyed by
 * `${contract.toLowerCase()}:${tokenId}`. Strategy:
 *   1. Filtered getLogs on Bazaar's NewAuction with `_auctionCreator`
 *      indexed-arg match → list of (contract, tokenId) candidates.
 *   2. Multicall `tokenAuctions(contract, tokenId)` to read live state.
 *   3. Filter to creator != 0 (entry deleted on settle/cancel) and ETH
 *      currency.
 *   4. Multicall `auctionBids(contract, tokenId)` for current bid amount.
 *
 * Bounded to renders of `/artist/<known>` (callers gate on `isCrawler`),
 * 30s pgCache. Trades 30s staleness for elimination of continuous
 * marketplace indexing.
 */

export type ActiveMapEntry = {
  reserveWei: bigint
  currentBidWei: bigint
  endTime: bigint
}

/**
 * Active SR V2 auctions for an artist, keyed by `contract:tokenId`.
 * Pure Postgres SELECT — the worker's `scan-srv2-active-auctions` task
 * maintains the table. Up to 5 min stale; bid button reads fresh chain
 * state at click-time and the contract rejects stale bids regardless.
 */
export async function getActiveSrV2AuctionMap(
  artist: Address,
): Promise<Record<string, ActiveMapEntry>> {
  if (!sql) return {}
  const rows = (await sql`
    SELECT contract, token_id, reserve_wei, current_bid_wei, end_time
    FROM srv2_active_auctions
    WHERE seller = ${artist.toLowerCase()} AND status = 'active'
  `) as Array<{
    contract: string; token_id: string;
    reserve_wei: string; current_bid_wei: string;
    end_time: number | string
  }>
  const out: Record<string, ActiveMapEntry> = {}
  for (const r of rows) {
    out[`${r.contract}:${r.token_id}`] = {
      reserveWei: BigInt(r.reserve_wei),
      currentBidWei: BigInt(r.current_bid_wei),
      endTime: BigInt(r.end_time),
    }
  }
  return out
}

/**
 * Active TL Auction House listings for an artist. Same Postgres-only
 * pattern as SR V2 above. Filtered to listing_type=2 (Reserve auction)
 * by the worker before insertion, so callers don't need to filter again.
 */
export async function getActiveTlAuctionMap(
  artist: Address,
): Promise<Record<string, ActiveMapEntry>> {
  if (!sql) return {}
  const rows = (await sql`
    SELECT contract, token_id, reserve_wei, current_bid_wei, end_time
    FROM tl_active_auctions
    WHERE seller = ${artist.toLowerCase()} AND status = 'active'
      AND listing_type = 2
  `) as Array<{
    contract: string; token_id: string;
    reserve_wei: string; current_bid_wei: string;
    end_time: number | string
  }>
  const out: Record<string, ActiveMapEntry> = {}
  for (const r of rows) {
    out[`${r.contract}:${r.token_id}`] = {
      reserveWei: BigInt(r.reserve_wei),
      currentBidWei: BigInt(r.current_bid_wei),
      endTime: BigInt(r.end_time),
    }
  }
  return out
}

/**
 * Current owner of a single token, when the indexed `token_owners`
 * value is stale-enough that the token detail page wants a fresh read.
 * 60s cache. Falls back to null on revert.
 */
export async function getCurrentOwner(
  contract: Address,
  tokenId: bigint,
): Promise<string | null> {
  return pgCache(
    `current-owner:${contract.toLowerCase()}:${tokenId.toString()}`,
    60,
    async () => {
      const client = getClient()
      try {
        const owner = await client.readContract({
          address: contract,
          abi: [{
            type: "function", name: "ownerOf", stateMutability: "view",
            inputs: [{ name: "tokenId", type: "uint256" }],
            outputs: [{ name: "", type: "address" }],
          }],
          functionName: "ownerOf",
          args: [tokenId],
        }) as string
        return owner.toLowerCase()
      } catch {
        return null
      }
    },
  )
}
