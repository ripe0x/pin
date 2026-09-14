/**
 * Auction state across an artist's SovereignAuctionHouse(s).
 *
 * An artist can hold a house on the V1 factory, the V2 factory, or both at
 * once during a migration. Both factories expose the same `houseOf(artist)`
 * getter, so both are resolved independently and cached the same way. Live
 * listings and bids come from whichever house currently holds them; history
 * (settled, cancelled, or unwound) is the union of both houses, each auction
 * tagged with its house address and version (see `mergeArtistHouses` and
 * `getAllAuctions`).
 *
 * Past auctions are read by scanning house events from the owning factory's
 * deploy block forward. No indexer.
 *
 * Caching: server-side `unstable_cache` with sensible revalidate windows.
 * Bigints are stringified at the cache boundary because Next's cache layer
 * JSON-serializes everything.
 *
 * Route identity: a numeric auctionId is scoped to one house, so the same id
 * can exist on both a V1 and a V2 house. `auctionRouteId`/`parseAuctionRouteId`
 * (in `./auction-status`) encode the house version into the `/auction/[id]`
 * URL segment: a bare number means V1 (preserving every link an artist has
 * already shared), and a `v2-` prefix means V2.
 *
 * Types, event ABIs, and pure decode/derivation logic live in
 * `./auction-status` (no `server-only` import there) so client components
 * and tests can use them directly without pulling this module's
 * `server-only` marker along for the ride.
 */
import "server-only"
import { unstable_cache } from "next/cache"
import type { Address } from "viem"
import { getClient, getLogsChunked, withDeadline } from "./rpc"
import {
  sovereignAuctionHouseAbi,
  sovereignAuctionHouseFactoryAbi,
  sovereignAuctionHouseV2Abi,
} from "./abi"
import { getConfig, ZERO_ADDRESS } from "./config"
import {
  auctionBidEvent,
  auctionCanceledEvent,
  auctionEndedEvent,
  auctionHouseCreatedEvent,
  fetchV2HouseEventData,
  mergeArtistHouses,
  parseAuctionRouteId,
  v1AuctionCreatedEvent,
  classifyV2LiveAuction,
  type AuctionStatus,
  type AuctionSummary,
  type ArtistHouses,
  type BidEntry,
  type HouseVersion,
  type V2HouseEventData,
  type V2LiveFlags,
} from "./auction-status"

export type {
  AuctionStatus,
  AuctionSummary,
  ArtistHouses,
  BidEntry,
  HouseRef,
  HouseVersion,
  TokenStandard,
  V2HouseEventData,
} from "./auction-status"
export { auctionRouteId, mergeArtistHouses, parseAuctionRouteId } from "./auction-status"

// ─── House resolution ───────────────────────────────────────────────────────

/**
 * Resolve one factory's house for the artist. Cached for 1 hour per
 * (artistAddress, factoryAddress) pair; a house address never changes once
 * deployed. RPC errors are left to throw rather than caught into a cached
 * null, so a transient failure retries on the next call instead of baking in
 * a false "no house" result for the whole revalidate window.
 */
const _getHouseOfCached = unstable_cache(
  async (
    artistAddress: Address,
    factoryAddress: Address,
  ): Promise<Address | null> => {
    const client = getClient()
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

export async function getArtistHouses(): Promise<ArtistHouses> {
  const { artistAddress, factoryAddress, v2FactoryAddress } = getConfig()
  const [v1, v2] = await Promise.all([
    _getHouseOfCached(artistAddress, factoryAddress),
    _getHouseOfCached(artistAddress, v2FactoryAddress),
  ])
  return mergeArtistHouses(v1, v2)
}

/** The artist's preferred single house (V2 if they have one, else V1, else null). */
export async function getArtistHouse(): Promise<Address | null> {
  const { v1, v2 } = await getArtistHouses()
  return v2 ?? v1
}

/**
 * The block at which a house was created: the tightest valid lower bound
 * for any event scan on it. Found via its factory's `AuctionHouseCreated`
 * event, filtered by the indexed `house` address.
 *
 * Cached for 30 days: the value is immutable. `factoryDeployBlock` is passed
 * as a string because unstable_cache JSON-serializes its arguments into the
 * cache key and bigints don't survive that. On lookup failure the caller
 * falls back to the (safe, just wider) factory deploy block.
 */
const _getHouseCreationBlockCached = unstable_cache(
  async (
    house: Address,
    factoryAddress: Address,
    factoryDeployBlock: string,
  ): Promise<number> => {
    const client = getClient()
    const latest = await client.getBlockNumber()
    const logs = await getLogsChunked({
      address: factoryAddress,
      event: auctionHouseCreatedEvent,
      args: { house },
      fromBlock: BigInt(factoryDeployBlock),
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

async function getHouseCreationBlock(
  house: Address,
  factoryAddress: Address,
  factoryDeployBlock: bigint,
): Promise<bigint> {
  try {
    return BigInt(
      await _getHouseCreationBlockCached(
        house,
        factoryAddress,
        factoryDeployBlock.toString(),
      ),
    )
  } catch {
    return factoryDeployBlock
  }
}

function factoryFor(config: ReturnType<typeof getConfig>, version: HouseVersion) {
  return version === 2
    ? { address: config.v2FactoryAddress, deployBlock: config.v2FactoryDeployBlock }
    : { address: config.factoryAddress, deployBlock: config.factoryDeployBlock }
}

// ─── Auction list (active + past), all houses ──────────────────────────────

const _getAllAuctionsCached = unstable_cache(
  async (artistAddress: Address): Promise<AuctionSummary[]> => {
    const { factoryAddress, v2FactoryAddress } = getConfig()
    const [v1House, v2House] = await Promise.all([
      _getHouseOfCached(artistAddress, factoryAddress),
      _getHouseOfCached(artistAddress, v2FactoryAddress),
    ])
    const { all } = mergeArtistHouses(v1House, v2House)
    if (all.length === 0) return []
    const perHouse = await Promise.all(
      all.map((h) =>
        h.version === 2
          ? fetchAuctionsForV2House(h.address)
          : fetchAuctionsForV1House(h.address),
      ),
    )
    return perHouse.flat()
  },
  ["all-auctions-v4"],
  { revalidate: 60, tags: ["all-auctions"] },
)

// Hard ceiling on a cold scan. The page renders on demand (not at build), so
// this guards the request path: a true cache miss must finish before the host
// kills the serverless function (~10s default on Netlify/Vercel). Healthy
// scans finish in a couple seconds; on RPC trouble we degrade to an empty list
// (the cache stays unpopulated, so the next request retries) rather than 500.
// Steady-state requests hit the warm cache and never reach this.
const ALL_AUCTIONS_DEADLINE_MS = 9_000

export async function getAllAuctions(): Promise<AuctionSummary[]> {
  const { artistAddress } = getConfig()
  return withDeadline(
    _getAllAuctionsCached(artistAddress),
    ALL_AUCTIONS_DEADLINE_MS,
    [],
  )
}

// ─── V1 house ───────────────────────────────────────────────────────────────

type V1HouseEventData = {
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

/**
 * Caching is the load-bearing part: a settled/cancelled auction is immutable
 * (the contract deleted its storage; the only record is in logs that never
 * change), so it should be derived from an archive `eth_getLogs` scan exactly
 * once, not on a timer and never at build. Two mechanisms get us there:
 *   - `pastCount` (the number of storage-deleted auctions) is threaded in as
 *     an argument purely so it becomes part of the cache key. It increments
 *     exactly when a new auction settles or cancels, so the cached value is
 *     reused untouched until then.
 *   - `revalidate` is a long 24h window rather than minutes: it's only a
 *     self-heal backstop (a scan can return partial data if an RPC window
 *     fails), not the normal refresh trigger.
 */
const _getV1HouseEventDataCached = unstable_cache(
  async (
    artistAddress: Address,
    house: Address,
    _pastCount: number,
  ): Promise<V1HouseEventData> => {
    void artistAddress
    void _pastCount
    const { factoryAddress, factoryDeployBlock } = getConfig()
    const client = getClient()
    const latest = await client.getBlockNumber()
    const fromBlock = await getHouseCreationBlock(house, factoryAddress, factoryDeployBlock)

    // One OR-filtered RPC scan for all lifecycle events. Three parallel scans
    // look harmless, but the bundled archive gateway permits only a small
    // request burst: one succeeds while the others rotate to providers whose
    // free tiers reject wide historical ranges. A single scan is both faster
    // and kinder to every provider.
    const history = await getLogsChunked({
      address: house,
      events: [v1AuctionCreatedEvent, auctionEndedEvent, auctionCanceledEvent] as const,
      fromBlock,
      toBlock: latest,
    })

    const data: V1HouseEventData = { created: {}, settled: {}, cancelled: [] }
    for (const log of history) {
      if (log.eventName === "AuctionCreated") {
        const id = log.args.auctionId
        if (id === undefined) continue
        data.created[id.toString()] = {
          tokenContract: (log.args.tokenContract ?? ZERO_ADDRESS) as Address,
          tokenId: (log.args.tokenId ?? 0n).toString(),
          reservePrice: (log.args.reservePrice ?? 0n).toString(),
          duration: (log.args.duration ?? 0n).toString(),
          tokenOwner: (log.args.tokenOwner ?? ZERO_ADDRESS) as Address,
        }
      } else if (log.eventName === "AuctionEnded") {
        const id = log.args.auctionId
        if (id === undefined) continue
        data.settled[id.toString()] = {
          winner: (log.args.winner ?? ZERO_ADDRESS) as Address,
          sellerProceeds: ((log.args.sellerProceeds ?? 0n) as bigint).toString(),
          protocolFee: ((log.args.protocolFee ?? 0n) as bigint).toString(),
        }
      } else if (log.eventName === "AuctionCanceled") {
        const id = log.args.auctionId
        if (id !== undefined) data.cancelled.push(id.toString())
      }
    }
    return data
  },
  ["house-event-data-v3"],
  { revalidate: 60 * 60 * 24, tags: ["all-auctions"] },
)

function buildV1PastSummary(
  house: Address,
  auctionId: string,
  created: V1HouseEventData["created"][string] | undefined,
  settled: V1HouseEventData["settled"][string] | undefined,
  cancelled: boolean,
): AuctionSummary {
  const base = {
    auctionId,
    house,
    houseVersion: 1 as const,
    tokenContract: (created?.tokenContract ?? ZERO_ADDRESS) as Address,
    tokenId: created?.tokenId ?? "0",
    reservePrice: created?.reservePrice ?? "0",
    duration: created?.duration ?? "0",
    tokenOwner: (created?.tokenOwner ?? ZERO_ADDRESS) as Address,
    fundsRecipient: (created?.tokenOwner ?? ZERO_ADDRESS) as Address,
    standard: "erc721" as const,
    quantity: "1",
    listingExpiry: "0",
    amount: "0",
    bidder: ZERO_ADDRESS as Address,
    endTime: "0",
    firstBidTime: "0",
  }
  if (cancelled) {
    return { ...base, status: "cancelled" }
  }
  if (settled) {
    const finalPrice = (BigInt(settled.sellerProceeds) + BigInt(settled.protocolFee)).toString()
    return {
      ...base,
      status: "settled",
      amount: finalPrice,
      bidder: settled.winner,
      finalPrice,
      winner: settled.winner,
    }
  }
  // No settle and no cancel events but storage deleted? Shouldn't happen, but
  // fall through as settled with zero data so the UI still has something.
  return { ...base, status: "settled" }
}

async function fetchAuctionsForV1House(house: Address): Promise<AuctionSummary[]> {
  const { artistAddress } = getConfig()
  const client = getClient()

  // `_nextAuctionId++` assigns ids starting at 0, so existing ids are
  // [0, nextId - 1].
  const nextId = await client
    .readContract({
      address: house,
      abi: sovereignAuctionHouseAbi,
      functionName: "nextAuctionId",
    })
    .catch(() => null)
  if (nextId === null || nextId === 0n) return []

  const ids = Array.from({ length: Number(nextId) }, (_, i) => BigInt(i))

  // Read current state for every id via multicall. Live/upcoming auctions
  // return a populated tuple; settled/cancelled ones have had their storage
  // deleted, so `tokenOwner` comes back as the zero address.
  const BATCH = 100
  const liveById = new Map<string, AuctionSummary>()
  const deletedIds: string[] = []

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const results = await client.multicall({
      contracts: batch.map((id) => ({
        address: house,
        abi: sovereignAuctionHouseAbi,
        functionName: "auctions" as const,
        args: [id] as const,
      })),
      allowFailure: true,
    })

    batch.forEach((id, idx) => {
      const idStr = id.toString()
      const r = results[idx]
      if (!r || r.status !== "success") {
        throw new Error(`auction storage read failed for id ${idStr}`)
      }
      if (r.result) {
        const tuple = r.result as readonly [
          bigint, Address, bigint, bigint, bigint, Address, bigint, Address, bigint,
        ]
        const [tId, tContract, firstBidTime, amount, rPrice, tOwner, endTime, bidder, dur] = tuple
        if (tOwner !== ZERO_ADDRESS) {
          const status: AuctionStatus = firstBidTime === 0n ? "upcoming" : "live"
          liveById.set(idStr, {
            auctionId: idStr,
            house,
            houseVersion: 1,
            tokenContract: tContract,
            tokenId: tId.toString(),
            reservePrice: rPrice.toString(),
            duration: dur.toString(),
            amount: amount.toString(),
            bidder,
            endTime: endTime.toString(),
            firstBidTime: firstBidTime.toString(),
            tokenOwner: tOwner,
            fundsRecipient: tOwner,
            standard: "erc721",
            quantity: "1",
            listingExpiry: "0",
            status,
          })
          return
        }
      }
      deletedIds.push(idStr)
    })
  }

  const auctions: AuctionSummary[] = [...liveById.values()]
  if (deletedIds.length > 0) {
    const events = await _getV1HouseEventDataCached(artistAddress, house, deletedIds.length)
    for (const idStr of deletedIds) {
      auctions.push(
        buildV1PastSummary(
          house,
          idStr,
          events.created[idStr],
          events.settled[idStr],
          events.cancelled.includes(idStr),
        ),
      )
    }
  }

  auctions.sort((a, b) => Number(BigInt(b.auctionId) - BigInt(a.auctionId)))
  return auctions
}

// ─── V2 house ───────────────────────────────────────────────────────────────

type V2AuctionTuple = readonly [
  bigint, // tokenId
  Address, // tokenContract
  bigint, // firstBidTime
  bigint, // amount
  bigint, // reservePrice
  Address, // tokenOwner
  Address, // fundsRecipient
  bigint, // endTime
  Address, // bidder
  bigint, // duration
  bigint, // quantity
  number, // standard (0 = ERC721, 1 = ERC1155)
]

const _getV2HouseEventDataCached = unstable_cache(
  async (
    artistAddress: Address,
    house: Address,
    _pastCount: number,
  ): Promise<V2HouseEventData> => {
    void artistAddress
    void _pastCount
    const { v2FactoryAddress, v2FactoryDeployBlock } = getConfig()
    const client = getClient()
    const latest = await client.getBlockNumber()
    const fromBlock = await getHouseCreationBlock(house, v2FactoryAddress, v2FactoryDeployBlock)
    return fetchV2HouseEventData(house, fromBlock, latest)
  },
  ["house-event-data-v2-v1"],
  { revalidate: 60 * 60 * 24, tags: ["all-auctions"] },
)

function buildV2PastSummary(
  house: Address,
  auctionId: string,
  events: V2HouseEventData,
): AuctionSummary {
  const created = events.created[auctionId]
  const base = {
    auctionId,
    house,
    houseVersion: 2 as const,
    tokenContract: (created?.tokenContract ?? ZERO_ADDRESS) as Address,
    tokenId: created?.tokenId ?? "0",
    reservePrice: created?.reservePrice ?? "0",
    duration: created?.duration ?? "0",
    tokenOwner: (created?.tokenOwner ?? ZERO_ADDRESS) as Address,
    fundsRecipient: (created?.fundsRecipient ?? ZERO_ADDRESS) as Address,
    standard: created?.standard ?? ("erc721" as const),
    quantity: created?.quantity ?? "1",
    listingExpiry: created?.listingExpiry ?? "0",
    amount: "0",
    bidder: ZERO_ADDRESS as Address,
    endTime: "0",
    firstBidTime: "0",
  }

  const unwound = events.unwound[auctionId]
  if (unwound) {
    return {
      ...base,
      status: "unwound",
      winner: unwound.winner,
      refundAmount: unwound.refundAmount,
    }
  }
  if (events.cancelled.includes(auctionId)) {
    return { ...base, status: "cancelled" }
  }
  const settled = events.settled[auctionId]
  if (settled) {
    const finalPrice = (BigInt(settled.sellerProceeds) + BigInt(settled.protocolFee)).toString()
    return {
      ...base,
      status: "settled",
      amount: finalPrice,
      bidder: settled.winner,
      finalPrice,
      winner: settled.winner,
    }
  }
  return { ...base, status: "settled" }
}

function buildV2LiveSummary(
  house: Address,
  auctionId: string,
  tuple: V2AuctionTuple,
  flags: V2LiveFlags,
): AuctionSummary {
  const [
    tokenId, tokenContract, firstBidTime, amount, reservePrice,
    tokenOwner, fundsRecipient, endTime, bidder, duration, quantity, standard,
  ] = tuple
  const classified = classifyV2LiveAuction(firstBidTime, flags)

  const summary: AuctionSummary = {
    auctionId,
    house,
    houseVersion: 2,
    tokenContract,
    tokenId: tokenId.toString(),
    reservePrice: reservePrice.toString(),
    duration: duration.toString(),
    amount: amount.toString(),
    bidder,
    endTime: endTime.toString(),
    firstBidTime: firstBidTime.toString(),
    tokenOwner,
    fundsRecipient,
    standard: standard === 1 ? "erc1155" : "erc721",
    quantity: quantity.toString(),
    listingExpiry: flags.listingExpiry.toString(),
    status: classified.status,
  }
  if (classified.status === "deferred" || classified.status === "unwound_return_pending") {
    summary.winner = bidder
  }
  if (classified.status === "unwound_return_pending") {
    summary.refundAmount = amount.toString()
  }
  if (classified.status === "deferred") {
    summary.deferredAt = flags.deferredAt.toString()
  }
  return summary
}

async function fetchAuctionsForV2House(house: Address): Promise<AuctionSummary[]> {
  const { artistAddress } = getConfig()
  const client = getClient()

  const nextId = await client
    .readContract({
      address: house,
      abi: sovereignAuctionHouseV2Abi,
      functionName: "nextAuctionId",
    })
    .catch(() => null)
  if (nextId === null || nextId === 0n) return []

  const ids = Array.from({ length: Number(nextId) }, (_, i) => BigInt(i))
  const BATCH = 100

  const liveById = new Map<string, AuctionSummary>()
  const deletedIds: string[] = []
  const pendingClassify: { idStr: string; tuple: V2AuctionTuple }[] = []

  // Pass 1: full auction record for every id. Live/upcoming/deferred/
  // return-pending auctions keep their storage populated (tokenOwner set);
  // settled/cancelled/fully-unwound ones have had it deleted.
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const results = await client.multicall({
      contracts: batch.map((id) => ({
        address: house,
        abi: sovereignAuctionHouseV2Abi,
        functionName: "auctions" as const,
        args: [id] as const,
      })),
      allowFailure: true,
    })

    batch.forEach((id, idx) => {
      const idStr = id.toString()
      const r = results[idx]
      if (!r || r.status !== "success") {
        throw new Error(`auction storage read failed for id ${idStr}`)
      }
      const tuple = r.result as V2AuctionTuple | undefined
      if (tuple && tuple[5] !== ZERO_ADDRESS) {
        pendingClassify.push({ idStr, tuple })
        return
      }
      deletedIds.push(idStr)
    })
  }

  // Pass 2: pendingDelivery/pendingReturn/deliveryDeferredAt/listingExpiry
  // for only the ids with populated storage, batched into one multicall per
  // BATCH-sized chunk rather than a read per id.
  const flagsById = new Map<string, V2LiveFlags>()
  for (let i = 0; i < pendingClassify.length; i += BATCH) {
    const batch = pendingClassify.slice(i, i + BATCH)
    const contracts = batch.flatMap(({ idStr }) => {
      const id = BigInt(idStr)
      return [
        { address: house, abi: sovereignAuctionHouseV2Abi, functionName: "pendingDelivery" as const, args: [id] as const },
        { address: house, abi: sovereignAuctionHouseV2Abi, functionName: "pendingReturn" as const, args: [id] as const },
        { address: house, abi: sovereignAuctionHouseV2Abi, functionName: "deliveryDeferredAt" as const, args: [id] as const },
        { address: house, abi: sovereignAuctionHouseV2Abi, functionName: "listingExpiry" as const, args: [id] as const },
      ]
    })
    const results = (await client.multicall({
      contracts: contracts as never,
      allowFailure: true,
    })) as readonly { status: "success" | "failure"; result?: unknown }[]
    batch.forEach(({ idStr }, batchIdx) => {
      const base = batchIdx * 4
      const pd = results[base]
      const pr = results[base + 1]
      const da = results[base + 2]
      const le = results[base + 3]
      flagsById.set(idStr, {
        pendingDelivery: pd?.status === "success" ? (pd.result as boolean) : false,
        pendingReturn: pr?.status === "success" ? (pr.result as boolean) : false,
        deferredAt: da?.status === "success" ? (da.result as bigint) : 0n,
        listingExpiry: le?.status === "success" ? (le.result as bigint) : 0n,
      })
    })
  }

  for (const { idStr, tuple } of pendingClassify) {
    const flags = flagsById.get(idStr) ?? {
      pendingDelivery: false,
      pendingReturn: false,
      deferredAt: 0n,
      listingExpiry: 0n,
    }
    liveById.set(idStr, buildV2LiveSummary(house, idStr, tuple, flags))
  }

  const auctions: AuctionSummary[] = [...liveById.values()]
  if (deletedIds.length > 0) {
    const events = await _getV2HouseEventDataCached(artistAddress, house, deletedIds.length)
    for (const idStr of deletedIds) {
      auctions.push(buildV2PastSummary(house, idStr, events))
    }
  }

  auctions.sort((a, b) => Number(BigInt(b.auctionId) - BigInt(a.auctionId)))
  return auctions
}

// ─── Single auction (for /auction/[id] detail page) ─────────────────────────

const _getAuctionByIdCached = unstable_cache(
  async (artistAddress: Address, routeId: string): Promise<AuctionSummary | null> => {
    const parsed = parseAuctionRouteId(routeId)
    if (!parsed) return null
    const all = await _getAllAuctionsCached(artistAddress)
    return (
      all.find(
        (a) => a.houseVersion === parsed.houseVersion && a.auctionId === parsed.auctionId,
      ) ?? null
    )
  },
  ["auction-by-id-v3"],
  { revalidate: 60, tags: ["all-auctions"] },
)

export async function getAuctionById(routeId: string): Promise<AuctionSummary | null> {
  const { artistAddress } = getConfig()
  return withDeadline(
    _getAuctionByIdCached(artistAddress, routeId),
    ALL_AUCTIONS_DEADLINE_MS,
    null,
  )
}

/**
 * Bid history for a single auction. Sorted newest first. Returns [] when
 * the auction has no bids or the scan fails. AuctionBid is identical on both
 * house versions, so the same event decode covers V1 and V2.
 */
const _getBidHistoryCached = unstable_cache(
  async (
    house: Address,
    houseVersion: HouseVersion,
    auctionId: string,
  ): Promise<BidEntry[]> => {
    const config = getConfig()
    const { address: factoryAddress, deployBlock: factoryDeployBlock } = factoryFor(
      config,
      houseVersion,
    )
    const client = getClient()
    const latest = await client.getBlockNumber()
    const fromBlock = await getHouseCreationBlock(house, factoryAddress, factoryDeployBlock)

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
  ["bid-history-v3"],
  { revalidate: 30, tags: ["all-auctions"] },
)

export async function getBidHistory(
  house: Address,
  houseVersion: HouseVersion,
  auctionId: string,
): Promise<BidEntry[]> {
  return withDeadline(
    _getBidHistoryCached(house, houseVersion, auctionId),
    ALL_AUCTIONS_DEADLINE_MS,
    [],
  )
}
