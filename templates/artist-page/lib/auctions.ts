/**
 * Auction state for an artist's SovereignAuctionHouse.
 *
 * The page is single-source: only auctions on this artist's house. We resolve
 * the house once via the factory (`houseOf(artist)`) and cache it for the
 * process lifetime — it doesn't change.
 *
 * Past auctions are read by scanning `AuctionCreated` + `AuctionEnded` events
 * on the house contract from the factory deploy block forward. No indexer.
 *
 * Caching: server-side `unstable_cache` with sensible revalidate windows.
 * Bigints are stringified at the cache boundary because Next's cache layer
 * JSON-serializes everything.
 */
import "server-only"
import { unstable_cache } from "next/cache"
import { parseAbiItem, type Address } from "viem"
import { getClient, getLogsChunked } from "./rpc"
import {
  sovereignAuctionHouseAbi,
  sovereignAuctionHouseFactoryAbi,
} from "./abi"
import { getConfig, ZERO_ADDRESS } from "./config"

const auctionCreatedEvent = parseAbiItem(
  "event AuctionCreated(uint256 indexed auctionId, uint256 indexed tokenId, address indexed tokenContract, uint256 duration, uint256 reservePrice, address tokenOwner)",
)
const auctionEndedEvent = parseAbiItem(
  "event AuctionEnded(uint256 indexed auctionId, address tokenOwner, address winner, uint256 sellerProceeds, uint256 protocolFee)",
)
const auctionCanceledEvent = parseAbiItem(
  "event AuctionCanceled(uint256 indexed auctionId)",
)
const auctionBidEvent = parseAbiItem(
  "event AuctionBid(uint256 indexed auctionId, address indexed bidder, uint256 amount, bool firstBid, bool extended)",
)

export type AuctionStatus = "live" | "upcoming" | "settled" | "cancelled"

export type AuctionSummary = {
  auctionId: string
  tokenContract: Address
  tokenId: string
  reservePrice: string // wei as decimal string
  duration: string // seconds
  /** Current high bid in wei. "0" if no bids. */
  amount: string
  bidder: Address
  endTime: string // unix seconds; "0" before first bid
  firstBidTime: string
  tokenOwner: Address
  status: AuctionStatus
  /** For settled auctions: final sale price in wei. Empty otherwise. */
  finalPrice?: string
  /** For settled auctions: winning bidder. Empty otherwise. */
  winner?: Address
}

export type BidEntry = {
  bidder: Address
  amount: string
  blockTime: number
  txHash: `0x${string}`
}

// ─── House resolution ───────────────────────────────────────────────────────

/**
 * Resolve the artist's SovereignAuctionHouse address. Returns null if the
 * artist hasn't deployed one yet — the page renders an empty state with a
 * link to the main app to deploy.
 *
 * Cached for 1 hour; the value almost never changes (an artist deploys
 * exactly one house, ever).
 */
export const getArtistHouse = unstable_cache(
  async (): Promise<Address | null> => {
    const { factoryAddress, artistAddress } = getConfig()
    const client = getClient()
    try {
      const house = await client.readContract({
        address: factoryAddress,
        abi: sovereignAuctionHouseFactoryAbi,
        functionName: "houseOf",
        args: [artistAddress],
      })
      if (house === ZERO_ADDRESS) return null
      return house as Address
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[auctions] houseOf failed", err)
      }
      return null
    }
  },
  ["artist-house-v1"],
  { revalidate: 60 * 60, tags: ["artist-house"] },
)

// ─── Auction list (active + past) ───────────────────────────────────────────

/**
 * All auctions on the artist's house, newest first. Uses
 * `AuctionCreated` events as the master list, then a `multicall` against
 * the house's `auctions(id)` getter for current state, plus
 * `AuctionEnded`/`AuctionCanceled` to disambiguate settled vs. cancelled.
 *
 * Returns an empty list when no house exists. Failure modes (RPC error
 * mid-scan) return what we have so far rather than throwing — the index
 * page degrades gracefully.
 */
export const getAllAuctions = unstable_cache(
  async (): Promise<AuctionSummary[]> => {
    const house = await getArtistHouse()
    if (!house) return []
    return fetchAllAuctionsForHouse(house)
  },
  ["all-auctions-v1"],
  { revalidate: 60, tags: ["all-auctions"] },
)

async function fetchAllAuctionsForHouse(
  house: Address,
): Promise<AuctionSummary[]> {
  const { factoryDeployBlock } = getConfig()
  const client = getClient()
  const latest = await client.getBlockNumber().catch(() => null)
  if (latest === null) return []

  // Scan three event streams in parallel. AuctionCreated is the master list;
  // AuctionEnded marks settled; AuctionCanceled marks cancelled. The first
  // is the bulk of the work — the others are sparse.
  const [created, ended, cancelled] = await Promise.all([
    getLogsChunked({
      address: house,
      event: auctionCreatedEvent,
      fromBlock: factoryDeployBlock,
      toBlock: latest,
    }),
    getLogsChunked({
      address: house,
      event: auctionEndedEvent,
      fromBlock: factoryDeployBlock,
      toBlock: latest,
    }),
    getLogsChunked({
      address: house,
      event: auctionCanceledEvent,
      fromBlock: factoryDeployBlock,
      toBlock: latest,
    }),
  ])

  if (created.length === 0) return []

  // Index settle / cancel logs by auctionId for O(1) lookup.
  const settledById = new Map<string, { winner: Address; sellerProceeds: bigint; protocolFee: bigint }>()
  for (const log of ended) {
    const id = log.args.auctionId
    if (id === undefined) continue
    settledById.set(id.toString(), {
      winner: (log.args.winner ?? ZERO_ADDRESS) as Address,
      sellerProceeds: (log.args.sellerProceeds ?? 0n) as bigint,
      protocolFee: (log.args.protocolFee ?? 0n) as bigint,
    })
  }
  const cancelledIds = new Set<string>()
  for (const log of cancelled) {
    const id = log.args.auctionId
    if (id !== undefined) cancelledIds.add(id.toString())
  }

  const ids = created
    .map((log) => log.args.auctionId)
    .filter((id): id is bigint => id !== undefined)

  // Read current on-chain state for every auctionId in batches via
  // multicall. The house deletes the storage slot for cancelled/settled
  // auctions, so a zero `tokenOwner` from the read tells us the auction
  // is no longer live (we cross-reference with settle/cancel events to
  // pick the right status).
  const BATCH = 100
  const auctions: AuctionSummary[] = []

  // Build a map: created event has the full set of static fields we need
  // for past auctions where the storage slot has been deleted. We also
  // need block.timestamp for sort ordering — fetch via getBlock per
  // unique block (small N for typical artist).
  const uniqueBlocks = Array.from(
    new Set(created.map((l) => l.blockNumber).filter((b): b is bigint => b !== null)),
  )
  const blockTimes = new Map<bigint, number>()
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      try {
        const block = await client.getBlock({ blockNumber: bn })
        blockTimes.set(bn, Number(block.timestamp))
      } catch {
        blockTimes.set(bn, 0)
      }
    }),
  )

  const createdByAuctionId = new Map<string, (typeof created)[number] & { _ts: number }>()
  for (const log of created) {
    const id = log.args.auctionId
    if (id === undefined) continue
    const ts = log.blockNumber !== null ? blockTimes.get(log.blockNumber) ?? 0 : 0
    createdByAuctionId.set(id.toString(), Object.assign(log, { _ts: ts }))
  }

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const results = await client
      .multicall({
        contracts: batch.map((id) => ({
          address: house,
          abi: sovereignAuctionHouseAbi,
          functionName: "auctions" as const,
          args: [id] as const,
        })),
        allowFailure: true,
      })
      .catch(() => [])

    batch.forEach((id, idx) => {
      const idStr = id.toString()
      const r = results[idx]
      const createdLog = createdByAuctionId.get(idStr)
      const settledInfo = settledById.get(idStr)
      const cancelledFlag = cancelledIds.has(idStr)

      // Default to event-only data (used for past auctions whose storage was deleted).
      const createdArgs = createdLog?.args
      const tokenContract = (createdArgs?.tokenContract ?? ZERO_ADDRESS) as Address
      const tokenId = createdArgs?.tokenId?.toString() ?? "0"
      const reservePrice = (createdArgs?.reservePrice ?? 0n).toString()
      const duration = (createdArgs?.duration ?? 0n).toString()
      const tokenOwner = (createdArgs?.tokenOwner ?? ZERO_ADDRESS) as Address

      let summary: AuctionSummary
      if (r && r.status === "success" && r.result) {
        // Live auction (storage slot still set).
        const tuple = r.result as readonly [
          bigint, Address, bigint, bigint, bigint, Address, bigint, Address, bigint,
        ]
        const [
          tId,
          tContract,
          firstBidTime,
          amount,
          rPrice,
          tOwner,
          endTime,
          bidder,
          dur,
        ] = tuple

        if (tOwner !== ZERO_ADDRESS) {
          const nowSec = Math.floor(Date.now() / 1000)
          const endNum = Number(endTime)
          const status: AuctionStatus =
            firstBidTime === 0n
              ? "upcoming"
              : endNum > 0 && endNum <= nowSec
                ? "live" // ended but not yet settled — surface as live so visitors can settle
                : "live"
          summary = {
            auctionId: idStr,
            tokenContract: tContract,
            tokenId: tId.toString(),
            reservePrice: rPrice.toString(),
            duration: dur.toString(),
            amount: amount.toString(),
            bidder,
            endTime: endTime.toString(),
            firstBidTime: firstBidTime.toString(),
            tokenOwner: tOwner,
            status,
          }
        } else {
          // Storage deleted — past auction. Use event data.
          summary = buildPastSummary(
            idStr,
            tokenContract,
            tokenId,
            reservePrice,
            duration,
            tokenOwner,
            settledInfo,
            cancelledFlag,
          )
        }
      } else {
        // Read failed — assume past, use event data.
        summary = buildPastSummary(
          idStr,
          tokenContract,
          tokenId,
          reservePrice,
          duration,
          tokenOwner,
          settledInfo,
          cancelledFlag,
        )
      }

      auctions.push(summary)
    })
  }

  // Sort newest auctions first by created-block timestamp.
  auctions.sort((a, b) => {
    const aTs = createdByAuctionId.get(a.auctionId)?._ts ?? 0
    const bTs = createdByAuctionId.get(b.auctionId)?._ts ?? 0
    return bTs - aTs
  })
  return auctions
}

function buildPastSummary(
  auctionId: string,
  tokenContract: Address,
  tokenId: string,
  reservePrice: string,
  duration: string,
  tokenOwner: Address,
  settled: { winner: Address; sellerProceeds: bigint; protocolFee: bigint } | undefined,
  cancelled: boolean,
): AuctionSummary {
  if (cancelled) {
    return {
      auctionId,
      tokenContract,
      tokenId,
      reservePrice,
      duration,
      amount: "0",
      bidder: ZERO_ADDRESS as Address,
      endTime: "0",
      firstBidTime: "0",
      tokenOwner,
      status: "cancelled",
    }
  }
  if (settled) {
    return {
      auctionId,
      tokenContract,
      tokenId,
      reservePrice,
      duration,
      amount: (settled.sellerProceeds + settled.protocolFee).toString(),
      bidder: settled.winner,
      endTime: "0",
      firstBidTime: "0",
      tokenOwner,
      status: "settled",
      finalPrice: (settled.sellerProceeds + settled.protocolFee).toString(),
      winner: settled.winner,
    }
  }
  // No settle and no cancel events but storage deleted? Shouldn't happen, but
  // fall through as settled with zero data so the UI still has something.
  return {
    auctionId,
    tokenContract,
    tokenId,
    reservePrice,
    duration,
    amount: "0",
    bidder: ZERO_ADDRESS as Address,
    endTime: "0",
    firstBidTime: "0",
    tokenOwner,
    status: "settled",
  }
}

// ─── Single auction (for /auction/[id] detail page) ─────────────────────────

export const getAuctionById = unstable_cache(
  async (auctionId: string): Promise<AuctionSummary | null> => {
    const all = await getAllAuctions()
    return all.find((a) => a.auctionId === auctionId) ?? null
  },
  ["auction-by-id-v1"],
  { revalidate: 60, tags: ["all-auctions"] },
)

/**
 * Bid history for a single auction. Sorted newest first. Returns [] when
 * the auction has no bids or the scan fails.
 */
export const getBidHistory = unstable_cache(
  async (auctionId: string): Promise<BidEntry[]> => {
    const house = await getArtistHouse()
    if (!house) return []
    const { factoryDeployBlock } = getConfig()
    const client = getClient()
    const latest = await client.getBlockNumber().catch(() => null)
    if (latest === null) return []

    const logs = await getLogsChunked({
      address: house,
      event: auctionBidEvent,
      args: { auctionId: BigInt(auctionId) },
      fromBlock: factoryDeployBlock,
      toBlock: latest,
    })

    if (logs.length === 0) return []

    const uniqueBlocks = Array.from(
      new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null)),
    )
    const blockTimes = new Map<bigint, number>()
    await Promise.all(
      uniqueBlocks.map(async (bn) => {
        try {
          const block = await client.getBlock({ blockNumber: bn })
          blockTimes.set(bn, Number(block.timestamp))
        } catch {
          blockTimes.set(bn, 0)
        }
      }),
    )

    const entries: BidEntry[] = logs
      .filter(
        (l): l is typeof l & { blockNumber: bigint; transactionHash: `0x${string}` } =>
          l.blockNumber !== null && l.transactionHash !== null,
      )
      .map((l) => ({
        bidder: l.args.bidder as Address,
        amount: ((l.args.amount ?? 0n) as bigint).toString(),
        blockTime: blockTimes.get(l.blockNumber) ?? 0,
        txHash: l.transactionHash,
      }))
    entries.sort((a, b) => b.blockTime - a.blockTime)
    return entries
  },
  ["bid-history-v1"],
  { revalidate: 30, tags: ["all-auctions"] },
)
