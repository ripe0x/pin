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

const auctionHouseCreatedEvent = parseAbiItem(
  "event AuctionHouseCreated(address indexed owner, address indexed house, address feeRecipient, uint16 protocolFeeBps)",
)
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
 *
 * Cache-keying note: the public function reads the artist address from
 * `getConfig()` and passes it through as an argument to the cached inner
 * function. `unstable_cache` hashes arguments into the cache key, so the
 * artist address ends up as part of the key. Without this, redeploying
 * the template against a different `NEXT_PUBLIC_ARTIST_ADDRESS` while
 * `.next/cache/` persisted would surface the *previous* artist's house
 * (stale cache hit on the same key).
 */
const _getArtistHouseCached = unstable_cache(
  async (artistAddress: Address): Promise<Address | null> => {
    const { factoryAddress } = getConfig()
    const client = getClient()
    // NOTE: we deliberately let RPC errors throw here rather than catching
    // and returning null. `unstable_cache` does not persist rejected
    // promises, so a transient RPC failure simply retries on the next call.
    // Catching and returning null would cache a *false* "no house deployed"
    // result for the full revalidate window — and, worse, bake it into a
    // build-time prerender — which is indistinguishable from a real zero
    // address. Only a confirmed ZERO_ADDRESS means "no house yet".
    const house = await client.readContract({
      address: factoryAddress,
      abi: sovereignAuctionHouseFactoryAbi,
      functionName: "houseOf",
      args: [artistAddress],
    })
    if (house === ZERO_ADDRESS) return null
    return house as Address
  },
  ["artist-house-v3"],
  { revalidate: 60 * 60, tags: ["artist-house"] },
)

export async function getArtistHouse(): Promise<Address | null> {
  const { artistAddress } = getConfig()
  return _getArtistHouseCached(artistAddress)
}

/**
 * The block at which the artist's house was created — the tightest valid
 * lower bound for any event scan on it (no house event can predate it).
 * Found via the factory's `AuctionHouseCreated` event, filtered by the
 * indexed `house` address so it returns a single log.
 *
 * Cached for 30 days: the value is immutable. On lookup failure we throw so
 * the (suboptimal-but-safe) factory-deploy-block fallback in the public
 * wrapper isn't cached as if it were the real answer.
 */
const _getHouseCreationBlockCached = unstable_cache(
  async (house: Address): Promise<number> => {
    const { factoryAddress, factoryDeployBlock } = getConfig()
    const client = getClient()
    const latest = await client.getBlockNumber()
    const logs = await getLogsChunked({
      address: factoryAddress,
      event: auctionHouseCreatedEvent,
      args: { house },
      fromBlock: factoryDeployBlock,
      toBlock: latest,
    })
    const bn = logs[0]?.blockNumber
    if (bn === null || bn === undefined) {
      throw new Error("AuctionHouseCreated log not found for house")
    }
    return Number(bn)
  },
  ["house-creation-block-v1"],
  { revalidate: 60 * 60 * 24 * 30, tags: ["artist-house"] },
)

async function getHouseCreationBlock(house: Address): Promise<bigint> {
  const { factoryDeployBlock } = getConfig()
  try {
    return BigInt(await _getHouseCreationBlockCached(house))
  } catch {
    // Factory deploy block is always <= house creation block, so it's a
    // safe (just wider) lower bound when the lookup fails.
    return factoryDeployBlock
  }
}

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
// See note on `getArtistHouse` above — passing artistAddress through as an
// argument so it becomes part of the cache key, even though we don't use it
// inside the body (we resolve via getArtistHouse, which has the same key).
const _getAllAuctionsCached = unstable_cache(
  async (artistAddress: Address): Promise<AuctionSummary[]> => {
    const house = await _getArtistHouseCached(artistAddress)
    if (!house) return []
    return fetchAllAuctionsForHouse(house)
  },
  ["all-auctions-v2"],
  { revalidate: 60, tags: ["all-auctions"] },
)

export async function getAllAuctions(): Promise<AuctionSummary[]> {
  const { artistAddress } = getConfig()
  return _getAllAuctionsCached(artistAddress)
}

/**
 * Per-house event data needed only to enrich *past* auctions (settled or
 * cancelled) whose storage slot the contract has deleted. Live/upcoming
 * auctions never need this — their full state is read directly from the
 * `auctions(id)` getter.
 *
 * All values are plain strings so the result is JSON-serializable for
 * `unstable_cache`'s disk layer (bigints are not). Cached for 5 minutes:
 * settled/cancelled history is effectively append-only, so we don't need to
 * rescan it on every 60s auction-list refresh.
 */
type HouseEventData = {
  created: Record<
    string,
    {
      tokenContract: Address
      tokenId: string
      reservePrice: string
      duration: string
      tokenOwner: Address
    }
  >
  settled: Record<string, { winner: Address; sellerProceeds: string; protocolFee: string }>
  cancelled: string[]
}

const _getHouseEventDataCached = unstable_cache(
  async (artistAddress: Address, house: Address): Promise<HouseEventData> => {
    const client = getClient()
    const latest = await client.getBlockNumber().catch(() => null)
    if (latest === null) return { created: {}, settled: {}, cancelled: [] }
    // Tightest valid lower bound — no house event predates its creation.
    const fromBlock = await getHouseCreationBlock(house)

    const [created, ended, cancelled] = await Promise.all([
      getLogsChunked({ address: house, event: auctionCreatedEvent, fromBlock, toBlock: latest }),
      getLogsChunked({ address: house, event: auctionEndedEvent, fromBlock, toBlock: latest }),
      getLogsChunked({ address: house, event: auctionCanceledEvent, fromBlock, toBlock: latest }),
    ])

    const data: HouseEventData = { created: {}, settled: {}, cancelled: [] }
    for (const log of created) {
      const id = log.args.auctionId
      if (id === undefined) continue
      data.created[id.toString()] = {
        tokenContract: (log.args.tokenContract ?? ZERO_ADDRESS) as Address,
        tokenId: (log.args.tokenId ?? 0n).toString(),
        reservePrice: (log.args.reservePrice ?? 0n).toString(),
        duration: (log.args.duration ?? 0n).toString(),
        tokenOwner: (log.args.tokenOwner ?? ZERO_ADDRESS) as Address,
      }
    }
    for (const log of ended) {
      const id = log.args.auctionId
      if (id === undefined) continue
      data.settled[id.toString()] = {
        winner: (log.args.winner ?? ZERO_ADDRESS) as Address,
        sellerProceeds: ((log.args.sellerProceeds ?? 0n) as bigint).toString(),
        protocolFee: ((log.args.protocolFee ?? 0n) as bigint).toString(),
      }
    }
    for (const log of cancelled) {
      const id = log.args.auctionId
      if (id !== undefined) data.cancelled.push(id.toString())
    }
    return data
  },
  ["house-event-data-v1"],
  { revalidate: 60 * 5, tags: ["all-auctions"] },
)

async function fetchAllAuctionsForHouse(
  house: Address,
): Promise<AuctionSummary[]> {
  const { artistAddress } = getConfig()
  const client = getClient()

  // 1. How many auctions has this house ever created? `_nextAuctionId++`
  //    assigns ids starting at 0, so existing ids are [0, nextId - 1].
  const nextId = await client
    .readContract({
      address: house,
      abi: sovereignAuctionHouseAbi,
      functionName: "nextAuctionId",
    })
    .catch(() => null)
  if (nextId === null || nextId === 0n) return []

  const ids = Array.from({ length: Number(nextId) }, (_, i) => BigInt(i))

  // 2. Read current state for every id via multicall. Live/upcoming auctions
  //    return a populated tuple; settled/cancelled ones have had their
  //    storage deleted, so `tokenOwner` comes back as the zero address.
  const BATCH = 100
  const liveById = new Map<string, AuctionSummary>()
  const deletedIds: string[] = []

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
      if (r && r.status === "success" && r.result) {
        const tuple = r.result as readonly [
          bigint, Address, bigint, bigint, bigint, Address, bigint, Address, bigint,
        ]
        const [tId, tContract, firstBidTime, amount, rPrice, tOwner, endTime, bidder, dur] = tuple
        if (tOwner !== ZERO_ADDRESS) {
          // Storage still set — live or upcoming.
          const status: AuctionStatus = firstBidTime === 0n ? "upcoming" : "live"
          liveById.set(idStr, {
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
          })
          return
        }
      }
      // Zero owner or read failed — storage deleted, so it's a past auction.
      deletedIds.push(idStr)
    })
  }

  // 3. Only when past auctions exist do we touch event logs at all — a house
  //    whose auctions are all still live never runs a single getLogs call.
  const auctions: AuctionSummary[] = [...liveById.values()]
  if (deletedIds.length > 0) {
    const events = await _getHouseEventDataCached(artistAddress, house)
    for (const idStr of deletedIds) {
      const c = events.created[idStr]
      const settled = events.settled[idStr]
      const settledInfo = settled
        ? {
            winner: settled.winner,
            sellerProceeds: BigInt(settled.sellerProceeds),
            protocolFee: BigInt(settled.protocolFee),
          }
        : undefined
      auctions.push(
        buildPastSummary(
          idStr,
          (c?.tokenContract ?? ZERO_ADDRESS) as Address,
          c?.tokenId ?? "0",
          c?.reservePrice ?? "0",
          c?.duration ?? "0",
          (c?.tokenOwner ?? ZERO_ADDRESS) as Address,
          settledInfo,
          events.cancelled.includes(idStr),
        ),
      )
    }
  }

  // 4. Newest first. auctionId is monotonic, so id order == chronological
  //    order — no per-block timestamp lookups needed.
  auctions.sort((a, b) => Number(BigInt(b.auctionId) - BigInt(a.auctionId)))
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

const _getAuctionByIdCached = unstable_cache(
  async (
    artistAddress: Address,
    auctionId: string,
  ): Promise<AuctionSummary | null> => {
    const all = await _getAllAuctionsCached(artistAddress)
    return all.find((a) => a.auctionId === auctionId) ?? null
  },
  ["auction-by-id-v2"],
  { revalidate: 60, tags: ["all-auctions"] },
)

export async function getAuctionById(
  auctionId: string,
): Promise<AuctionSummary | null> {
  const { artistAddress } = getConfig()
  return _getAuctionByIdCached(artistAddress, auctionId)
}

/**
 * Bid history for a single auction. Sorted newest first. Returns [] when
 * the auction has no bids or the scan fails.
 */
const _getBidHistoryCached = unstable_cache(
  async (artistAddress: Address, auctionId: string): Promise<BidEntry[]> => {
    const house = await _getArtistHouseCached(artistAddress)
    if (!house) return []
    const client = getClient()
    const latest = await client.getBlockNumber().catch(() => null)
    if (latest === null) return []
    const fromBlock = await getHouseCreationBlock(house)

    const logs = await getLogsChunked({
      address: house,
      event: auctionBidEvent,
      args: { auctionId: BigInt(auctionId) },
      fromBlock,
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
  ["bid-history-v2"],
  { revalidate: 30, tags: ["all-auctions"] },
)

export async function getBidHistory(auctionId: string): Promise<BidEntry[]> {
  const { artistAddress } = getConfig()
  return _getBidHistoryCached(artistAddress, auctionId)
}
