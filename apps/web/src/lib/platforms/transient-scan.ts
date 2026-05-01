import "server-only"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import {
  TL_AUCTION_HOUSE,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import {
  readScanCursor,
  writeScanCursor,
  writeTransientActiveAuctions,
  readTransientActiveAuctions,
  LAZY_TTL,
  isFresh,
  type LazyTransientActiveAuction,
} from "../lazy-index"

const TL_AH = TL_AUCTION_HOUSE[MAINNET_CHAIN_ID]
const SCAN_KEY = "tl_auction_house"
// Auction House v2.6.1 was deployed in early 2026. Block 24_500_000
// pre-dates the deploy comfortably. First scan will catch up to head
// across multiple home-grid hits (deadline-bounded per call).
const TL_AUCTION_HOUSE_DEPLOY_BLOCK = 24_500_000n
// Per-call chunk for the unindexed scan. Same shape as the SR V2
// scanner: 500K blocks default with halve-and-retry on failure.
const BLOCK_RANGE = 500_000n
const MIN_CHUNK = 10_000n
const COOLDOWN_MS = LAZY_TTL.transientAuctionScan
const SCAN_TIMEOUT_MS = 10_000

// Listing tuple shape — must match the ABI/adapter. Decoding via
// viem's `parseAbiItem` keeps the inline types ergonomic.
const listingConfiguredEvent = parseAbiItem(
  "event ListingConfigured(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)
const auctionBidEvent = parseAbiItem(
  "event AuctionBid(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)
const auctionSettledEvent = parseAbiItem(
  "event AuctionSettled(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)
const buyNowFulfilledEvent = parseAbiItem(
  "event BuyNowFulfilled(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, address recipient, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)
const listingCanceledEvent = parseAbiItem(
  "event ListingCanceled(address indexed sender, address indexed nftAddress, uint256 indexed tokenId, (uint8,bool,address,address,address,uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256) listing)",
)

const ETH_CURRENCY = "0x0000000000000000000000000000000000000000"
const ZERO_ADDRESS_LOWER = "0x0000000000000000000000000000000000000000"

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com",
      { batch: true },
    ),
  })
}

type ListingTuple = readonly [
  number, // type_
  boolean, // zeroProtocolFee
  Address, // seller
  Address, // payoutReceiver
  Address, // currencyAddress
  bigint, // openTime
  bigint, // reservePrice
  bigint, // buyNowPrice
  bigint, // startTime
  bigint, // duration
  Address, // recipient
  Address, // highestBidder
  bigint, // highestBid
  bigint, // id
]

type ScanLog = {
  blockNumber: bigint | null
  logIndex: number | null
  args: { nftAddress?: Address; tokenId?: bigint; listing?: ListingTuple }
  eventName:
    | "ListingConfigured"
    | "AuctionBid"
    | "AuctionSettled"
    | "BuyNowFulfilled"
    | "ListingCanceled"
}

function tokenKey(contract: string, tokenId: string): string {
  return `${contract.toLowerCase()}:${tokenId}`
}

function logSortKey(l: ScanLog): bigint {
  const block = l.blockNumber ?? 0n
  const idx = BigInt(l.logIndex ?? 0)
  return block * 100_000n + idx
}

/**
 * Incrementally update `lazy_tl_active_auctions` from Auction House
 * events. Cooldown-bounded so the home-grid orchestrator can call this
 * on every render without thrashing. First run covers the contract's
 * lifetime; subsequent runs pick up from the cursor.
 */
export async function refreshTransientAuctions(): Promise<void> {
  const cursor = await readScanCursor(SCAN_KEY)
  if (cursor && isFresh(cursor.lastScannedAt, COOLDOWN_MS)) return

  const client = getClient()
  const latestBlock = await client.getBlockNumber()
  const fromBlock = cursor ? cursor.lastBlock + 1n : TL_AUCTION_HOUSE_DEPLOY_BLOCK
  if (fromBlock > latestBlock) {
    await writeScanCursor(SCAN_KEY, latestBlock)
    return
  }

  const deadline = Date.now() + SCAN_TIMEOUT_MS
  const existingRows = await readTransientActiveAuctions(10_000)
  const byKey = new Map<string, LazyTransientActiveAuction>()
  for (const r of existingRows) byKey.set(tokenKey(r.contract, r.tokenId), r)

  async function fetchChunk(
    start: bigint,
    end: bigint,
  ): Promise<ScanLog[] | null> {
    try {
      const [configured, bids, settled, buyNow, canceled] = await Promise.all([
        client.getLogs({
          address: TL_AH,
          event: listingConfiguredEvent,
          fromBlock: start,
          toBlock: end,
        }),
        client.getLogs({
          address: TL_AH,
          event: auctionBidEvent,
          fromBlock: start,
          toBlock: end,
        }),
        client.getLogs({
          address: TL_AH,
          event: auctionSettledEvent,
          fromBlock: start,
          toBlock: end,
        }),
        client.getLogs({
          address: TL_AH,
          event: buyNowFulfilledEvent,
          fromBlock: start,
          toBlock: end,
        }),
        client.getLogs({
          address: TL_AH,
          event: listingCanceledEvent,
          fromBlock: start,
          toBlock: end,
        }),
      ])
      return [
        ...configured.map((l) => ({ ...l, eventName: "ListingConfigured" as const })),
        ...bids.map((l) => ({ ...l, eventName: "AuctionBid" as const })),
        ...settled.map((l) => ({ ...l, eventName: "AuctionSettled" as const })),
        ...buyNow.map((l) => ({ ...l, eventName: "BuyNowFulfilled" as const })),
        ...canceled.map((l) => ({ ...l, eventName: "ListingCanceled" as const })),
      ] as unknown as ScanLog[]
    } catch {
      if (end - start <= MIN_CHUNK) return null
      const mid = start + (end - start) / 2n
      const a = await fetchChunk(start, mid)
      const b = await fetchChunk(mid + 1n, end)
      if (a === null && b === null) return null
      return [...(a ?? []), ...(b ?? [])]
    }
  }

  let scannedTo = fromBlock - 1n
  for (let start = fromBlock; start <= latestBlock; start += BLOCK_RANGE) {
    if (Date.now() > deadline) break
    const end = start + BLOCK_RANGE - 1n > latestBlock
      ? latestBlock
      : start + BLOCK_RANGE - 1n

    const logs = await fetchChunk(start, end)
    if (logs === null) break

    logs.sort((a, b) => {
      const ak = logSortKey(a)
      const bk = logSortKey(b)
      return ak > bk ? 1 : ak < bk ? -1 : 0
    })

    for (const l of logs) {
      const nftAddress = l.args.nftAddress?.toLowerCase()
      const tokenIdRaw = l.args.tokenId
      const listing = l.args.listing
      if (!nftAddress || tokenIdRaw === undefined || !listing) continue
      const tokenId = tokenIdRaw.toString()
      const key = tokenKey(nftAddress, tokenId)
      const existing = byKey.get(key)

      const [
        type_,
        ,
        seller,
        ,
        currencyAddress,
        ,
        reservePrice,
        ,
        startTime,
        duration,
        ,
        highestBidder,
        highestBid,
      ] = listing

      // Skip ERC-20 listings; only ETH (currencyAddress = 0x0) surfaces.
      const ethListing =
        currencyAddress.toLowerCase() === ETH_CURRENCY

      if (l.eventName === "ListingConfigured") {
        if (!ethListing) {
          if (existing) byKey.delete(key)
          continue
        }
        byKey.set(key, {
          contract: nftAddress,
          tokenId,
          seller: seller.toLowerCase(),
          reserveWei: reservePrice,
          currentBidWei: 0n,
          currentBidder: null,
          endTime: 0,
          status: "active",
          listingType: type_,
          startedAtBlock: l.blockNumber ?? 0n,
        })
      } else if (l.eventName === "AuctionBid") {
        if (!ethListing) continue
        if (!existing) {
          // Bid landed without a ListingConfigured we tracked
          // (cursor missed it). Synthesize a row from the listing
          // tuple — TL's event includes the full struct so we don't
          // need a follow-up read.
          byKey.set(key, {
            contract: nftAddress,
            tokenId,
            seller: seller === "0x0000000000000000000000000000000000000000"
              ? ZERO_ADDRESS_LOWER
              : seller.toLowerCase(),
            reserveWei: reservePrice,
            currentBidWei: highestBid,
            currentBidder: highestBidder.toLowerCase(),
            endTime: Number(startTime + duration),
            status: "active",
            listingType: type_,
            startedAtBlock: l.blockNumber ?? 0n,
          })
        } else {
          existing.currentBidWei = highestBid
          existing.currentBidder = highestBidder.toLowerCase()
          // TL writes startTime to the bid block timestamp on the
          // first bid; the listing struct on subsequent bids carries
          // the same startTime, so endTime = startTime + duration is
          // exact (no chain-head approximation needed, unlike SR).
          existing.endTime = Number(startTime + duration)
        }
      } else if (l.eventName === "AuctionSettled") {
        if (existing) existing.status = "settled"
      } else if (l.eventName === "BuyNowFulfilled") {
        // Buy-now exits the listing immediately, just like a settle.
        // We still track it in the active table briefly so the home
        // grid renders the moment it happened; it'll be filtered out
        // by `WHERE status='active'`.
        if (existing) existing.status = "settled"
      } else if (l.eventName === "ListingCanceled") {
        if (existing) existing.status = "cancelled"
      }
    }

    scannedTo = end
  }

  if (byKey.size > 0) {
    writeTransientActiveAuctions([...byKey.values()])
  }
  await writeScanCursor(SCAN_KEY, scannedTo > 0n ? scannedTo : latestBlock)
}
