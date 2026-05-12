import "server-only"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem"
import { mainnet } from "viem/chains"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import type {
  SellerCancellableAuction,
  SellerCancellableBuyNow,
  SellerListings,
} from "./types"
import { getAlchemyMainnetUrl } from "../alchemy-rpc"

/**
 * Foundation-specific cancellable-listings discovery via direct RPC.
 *
 * Two parallel event scans on the NFTMarket contract — `ReserveAuctionCreated`
 * and `BuyPriceSet`, both filtered on the indexed seller topic — then a
 * multicall pass to drop anything that's no longer active (cancelled,
 * finalized, sold, or — for auctions — already received a bid, since
 * `cancelReserveAuction` reverts after the first bid).
 *
 * Lives in its own module (rather than inline on `foundation.ts`) so the
 * adapter file stays focused on the registry interface methods.
 */

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// NFTMarket proxy was deployed Dec 2021 — same anchor as auctions.ts:74.
const NFT_MARKET_DEPLOY_BLOCK = 13_840_000n
const BLOCK_RANGE = 2_000_000n

const reserveAuctionCreatedEvent = parseAbiItem(
  "event ReserveAuctionCreated(address indexed seller, address indexed nftContract, uint256 indexed tokenId, uint256 duration, uint256 extensionDuration, uint256 reservePrice, uint256 auctionId)",
)

const buyPriceSetEvent = parseAbiItem(
  "event BuyPriceSet(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 price)",
)

function getClient(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      getAlchemyMainnetUrl(),
    ),
  })
}

/**
 * Cached auction context passed in from the lazy cache so the live scan
 * can skip already-known auctions and only fetch new NewAuction events
 * since the last refresh. The multicall step still re-confirms every
 * candidate (cached + new) so cancels / finalizes that landed in the gap
 * drop out.
 */
export type FndDiscoveryCache = {
  auctionIds: bigint[]
  durationByAuctionId: Map<bigint, bigint>
  buyNowKeys: Map<string, { nftContract: Address; tokenId: bigint }>
}

export async function discoverFoundationCancellableListings(
  sellerAddress: string,
  options: { fromBlock?: bigint; cached?: FndDiscoveryCache } = {},
): Promise<{ listings: SellerListings; scannedTo: bigint }> {
  const client = getClient()
  const seller = sellerAddress.toLowerCase() as Address
  const latestBlock = await client.getBlockNumber()
  const fromBlock = options.fromBlock ?? NFT_MARKET_DEPLOY_BLOCK

  // Empty scans when fromBlock > latest (a tight TTL retry with no new
  // blocks). The multicall below still runs to re-confirm liveness on
  // the cached candidate set.
  const [auctionLogs, buyPriceLogs] =
    fromBlock > latestBlock
      ? [[], []]
      : await Promise.all([
          getLogs(
            client,
            MARKET_ADDRESS,
            reserveAuctionCreatedEvent,
            { seller },
            fromBlock,
            latestBlock,
          ),
          getLogs(
            client,
            MARKET_ADDRESS,
            buyPriceSetEvent,
            { seller },
            fromBlock,
            latestBlock,
          ),
        ])

  // Start from cached candidates, then layer new events on top. Same
  // dedupe rule as before: first sight wins for auctionIds (each gets
  // exactly one Created event); buy-nows dedupe by (contract, tokenId)
  // since BuyPriceSet fires per-update and the read-back resolves the
  // current price.
  const durationByAuctionId = new Map<bigint, bigint>(
    options.cached?.durationByAuctionId ?? [],
  )
  for (const log of auctionLogs) {
    const args = (log as { args: { auctionId: bigint; duration: bigint } }).args
    if (!durationByAuctionId.has(args.auctionId)) {
      durationByAuctionId.set(args.auctionId, args.duration)
    }
  }
  const auctionIds = Array.from(durationByAuctionId.keys())

  const buyNowKeys = new Map<
    string,
    { nftContract: Address; tokenId: bigint }
  >(options.cached?.buyNowKeys ?? [])
  for (const log of buyPriceLogs) {
    const args = (log as { args: { nftContract: Address; tokenId: bigint } })
      .args
    const key = `${args.nftContract.toLowerCase()}:${args.tokenId.toString()}`
    if (!buyNowKeys.has(key)) {
      buyNowKeys.set(key, { nftContract: args.nftContract, tokenId: args.tokenId })
    }
  }

  const [auctions, buyNows] = await Promise.all([
    confirmActiveAuctions(client, auctionIds, durationByAuctionId, seller),
    confirmActiveBuyNows(client, Array.from(buyNowKeys.values()), seller),
  ])

  return {
    listings: { auctions, buyNows },
    scannedTo: latestBlock,
  }
}

async function confirmActiveAuctions(
  client: PublicClient,
  auctionIds: bigint[],
  durationByAuctionId: Map<bigint, bigint>,
  seller: Address,
): Promise<SellerCancellableAuction[]> {
  if (auctionIds.length === 0) return []

  const out: SellerCancellableAuction[] = []

  for (let i = 0; i < auctionIds.length; i += 50) {
    const batch = auctionIds.slice(i, i + 50)
    const results = await client.multicall({
      contracts: batch.map((auctionId) => ({
        address: MARKET_ADDRESS,
        abi: nftMarketAbi,
        functionName: "getReserveAuction" as const,
        args: [auctionId] as const,
      })),
    })

    batch.forEach((auctionId, j) => {
      const r = results[j]
      if (r.status !== "success") return
      const a = r.result as {
        nftContract: Address
        tokenId: bigint
        seller: Address
        endTime: bigint
        bidder: Address
        amount: bigint
      }
      // Cancellable iff still owned by seller and no bid yet —
      // `cancelReserveAuction` reverts once bidder is set / endTime is non-zero.
      if (a.seller.toLowerCase() !== seller) return
      if (a.bidder !== ZERO_ADDRESS) return
      if (a.endTime !== 0n) return

      const duration = durationByAuctionId.get(auctionId) ?? 0n
      out.push({
        id: `fnd:auction:${auctionId.toString()}`,
        platform: "foundation",
        auctionId: auctionId.toString(),
        nftContract: a.nftContract,
        tokenId: a.tokenId.toString(),
        reserveWei: a.amount.toString(),
        durationSeconds: Number(duration),
      })
    })
  }

  return out
}

async function confirmActiveBuyNows(
  client: PublicClient,
  candidates: Array<{ nftContract: Address; tokenId: bigint }>,
  seller: Address,
): Promise<SellerCancellableBuyNow[]> {
  if (candidates.length === 0) return []

  const out: SellerCancellableBuyNow[] = []

  for (let i = 0; i < candidates.length; i += 50) {
    const batch = candidates.slice(i, i + 50)
    const results = await client.multicall({
      contracts: batch.map((c) => ({
        address: MARKET_ADDRESS,
        abi: nftMarketAbi,
        functionName: "getBuyPrice" as const,
        args: [c.nftContract, c.tokenId] as const,
      })),
    })

    batch.forEach((c, j) => {
      const r = results[j]
      if (r.status !== "success") return
      const bp = r.result as { seller: Address; price: bigint }
      if (bp.seller.toLowerCase() !== seller) return
      if (bp.price === 0n) return

      out.push({
        id: `fnd:buyNow:${c.nftContract.toLowerCase()}:${c.tokenId.toString()}`,
        platform: "foundation",
        nftContract: c.nftContract,
        tokenId: c.tokenId.toString(),
        priceWei: bp.price.toString(),
      })
    })
  }

  return out
}

/**
 * Generic paginated log fetcher — splits the range on RPC failure. Mirrors
 * the helper in `onchain-discovery.ts`; kept private here to keep modules
 * independent.
 */
async function getLogs(
  client: PublicClient,
  address: Address,
  event: ReturnType<typeof parseAbiItem>,
  args: Record<string, unknown>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<unknown[]> {
  const allLogs: unknown[] = []

  for (let start = fromBlock; start <= toBlock; start += BLOCK_RANGE) {
    const end = start + BLOCK_RANGE - 1n > toBlock ? toBlock : start + BLOCK_RANGE - 1n
    try {
      const logs = await client.getLogs({
        address,
        // viem's getLogs is overloaded; the typed wrapper struggles with
        // a generic AbiEvent here — the runtime call is correct.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        event: event as any,
        args,
        fromBlock: start,
        toBlock: end,
      })
      allLogs.push(...logs)
    } catch {
      if (end - start > 10_000n) {
        const mid = start + (end - start) / 2n
        const firstHalf = await getLogs(client, address, event, args, start, mid)
        const secondHalf = await getLogs(client, address, event, args, mid + 1n, end)
        allLogs.push(...firstHalf, ...secondHalf)
      }
    }
  }

  return allLogs
}
