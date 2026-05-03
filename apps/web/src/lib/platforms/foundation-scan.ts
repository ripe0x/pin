import "server-only"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import {
  writeFoundationActiveAuctions,
  readFoundationArtistAuctionStatus,
  writeFoundationArtistAuctionStatus,
  LAZY_TTL,
  isFresh,
  type LazyFoundationActiveAuction,
} from "../lazy-index"
import { getAlchemyMainnetUrl } from "../alchemy-rpc"

const FND_NFT_MARKET = NFT_MARKET[MAINNET_CHAIN_ID]
// NFTMarket proxy was deployed mid-2021. Per-artist `getLogs` calls
// filter on indexed seller / auctionId topics, so the RPC returns only
// that artist's events regardless of how wide the block range is.
const FND_NFT_MARKET_DEPLOY_BLOCK = 12_700_000n
const COOLDOWN_MS = LAZY_TTL.foundationArtistAuctions

const reserveAuctionCreatedEvent = parseAbiItem(
  "event ReserveAuctionCreated(address indexed seller, address indexed nftContract, uint256 indexed tokenId, uint256 duration, uint256 extensionDuration, uint256 reservePrice, uint256 auctionId)",
)
const reserveAuctionBidPlacedEvent = parseAbiItem(
  "event ReserveAuctionBidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 endTime)",
)
const reserveAuctionFinalizedEvent = parseAbiItem(
  "event ReserveAuctionFinalized(uint256 indexed auctionId, address indexed seller, address indexed bidder, uint256 totalFees, uint256 creatorRev, uint256 sellerRev)",
)
const reserveAuctionCanceledEvent = parseAbiItem(
  "event ReserveAuctionCanceled(uint256 indexed auctionId)",
)
const reserveAuctionUpdatedEvent = parseAbiItem(
  "event ReserveAuctionUpdated(uint256 indexed auctionId, uint256 reservePrice)",
)
const reserveAuctionInvalidatedEvent = parseAbiItem(
  "event ReserveAuctionInvalidated(uint256 indexed auctionId)",
)

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      getAlchemyMainnetUrl(),
      { batch: true },
    ),
  })
}

const tokenCreatorAbi = [
  {
    type: "function",
    name: "tokenCreator",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const

const ownerAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const

/**
 * Lazy-index this artist's NFTMarket reserve auctions.
 *
 * Two-phase event walk, per-artist:
 *
 *   1. `ReserveAuctionCreated` filtered by `seller=artist` (indexed
 *      topic) — gives every auction this artist has ever started,
 *      with `auctionId`. The RPC returns only this artist's logs, so
 *      walking from the contract's deploy block is cheap.
 *   2. For all collected `auctionId`s, run `Bid` / `Finalized` /
 *      `Canceled` / `Updated` / `Invalidated` `getLogs` in parallel,
 *      filtered by `auctionId IN (…)` (indexed). Each call returns
 *      only events for this artist's auctions.
 *
 * Reduces the union of events to current state and upserts into
 * `lazy_fnd_active_auctions`. Stamps the artist's status row at the
 * end so the home grid's 24h freshness join surfaces them. Self-cools
 * via `LAZY_TTL.foundationArtistAuctions` (2 min) so repeated artist-
 * page hits don't thrash.
 */
export async function discoverFoundationArtistAuctions(
  artist: Address,
): Promise<void> {
  const status = await readFoundationArtistAuctionStatus(artist)
  if (status && isFresh(status.lastIndexedAt, COOLDOWN_MS)) return

  const client = getClient()
  const fromBlock = FND_NFT_MARKET_DEPLOY_BLOCK
  const sellerLower = artist.toLowerCase() as Address

  // Phase 1 — every auction this artist has created.
  const createdLogs = await client.getLogs({
    address: FND_NFT_MARKET,
    event: reserveAuctionCreatedEvent,
    args: { seller: sellerLower },
    fromBlock,
  })

  if (createdLogs.length === 0) {
    // Even with no auctions, stamp the status so the home grid doesn't
    // re-trigger a full scan on every page load. (Future scans will
    // catch up if the artist later lists something.)
    await writeFoundationArtistAuctionStatus(sellerLower)
    return
  }

  const byId = new Map<string, LazyFoundationActiveAuction>()
  for (const l of createdLogs) {
    const auctionId = l.args.auctionId
    const nftContract = l.args.nftContract?.toLowerCase()
    const tokenIdRaw = l.args.tokenId
    const reservePrice = l.args.reservePrice
    if (
      auctionId === undefined ||
      nftContract === undefined ||
      tokenIdRaw === undefined ||
      reservePrice === undefined
    ) {
      continue
    }
    byId.set(auctionId.toString(), {
      auctionId,
      contract: nftContract,
      tokenId: tokenIdRaw.toString(),
      seller: sellerLower,
      reserveWei: reservePrice,
      currentBidWei: 0n,
      currentBidder: null,
      endTime: 0,
      status: "active",
      startedAtBlock: l.blockNumber ?? 0n,
      creator: null,
    })
  }

  const auctionIds = Array.from(byId.keys()).map((id) => BigInt(id))

  // Phase 2 — apply Bid / Finalized / Canceled / Updated / Invalidated
  // events filtered by this artist's auctionIds. All five queries run
  // in parallel; viem encodes the array as a topic-OR filter.
  //
  // RPC providers cap topic-filter array length somewhere around
  // 100–1000 entries; chunk to be safe. Most artists have far fewer
  // auctions than the chunk size so this is typically one parallel
  // call per event type.
  const ID_CHUNK = 200
  const idChunks: bigint[][] = []
  for (let i = 0; i < auctionIds.length; i += ID_CHUNK) {
    idChunks.push(auctionIds.slice(i, i + ID_CHUNK))
  }

  const [bidLogs, finalizedLogs, canceledLogs, updatedLogs, invalidatedLogs] =
    await Promise.all([
      Promise.all(
        idChunks.map((chunk) =>
          client.getLogs({
            address: FND_NFT_MARKET,
            event: reserveAuctionBidPlacedEvent,
            args: { auctionId: chunk },
            fromBlock,
          }),
        ),
      ).then((arr) => arr.flat()),
      Promise.all(
        idChunks.map((chunk) =>
          client.getLogs({
            address: FND_NFT_MARKET,
            event: reserveAuctionFinalizedEvent,
            args: { auctionId: chunk },
            fromBlock,
          }),
        ),
      ).then((arr) => arr.flat()),
      Promise.all(
        idChunks.map((chunk) =>
          client.getLogs({
            address: FND_NFT_MARKET,
            event: reserveAuctionCanceledEvent,
            args: { auctionId: chunk },
            fromBlock,
          }),
        ),
      ).then((arr) => arr.flat()),
      Promise.all(
        idChunks.map((chunk) =>
          client.getLogs({
            address: FND_NFT_MARKET,
            event: reserveAuctionUpdatedEvent,
            args: { auctionId: chunk },
            fromBlock,
          }),
        ),
      ).then((arr) => arr.flat()),
      Promise.all(
        idChunks.map((chunk) =>
          client.getLogs({
            address: FND_NFT_MARKET,
            event: reserveAuctionInvalidatedEvent,
            args: { auctionId: chunk },
            fromBlock,
          }),
        ),
      ).then((arr) => arr.flat()),
    ])

  // Apply in chronological order so later events overwrite earlier
  // state correctly (e.g. extension bid → final settle).
  type AppliedLog = {
    blockNumber: bigint | null
    logIndex: number | null
    kind: "bid" | "finalized" | "canceled" | "updated" | "invalidated"
    args:
      | (typeof bidLogs)[number]["args"]
      | (typeof finalizedLogs)[number]["args"]
      | (typeof canceledLogs)[number]["args"]
      | (typeof updatedLogs)[number]["args"]
      | (typeof invalidatedLogs)[number]["args"]
  }
  const applied: AppliedLog[] = [
    ...bidLogs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "bid" as const,
      args: l.args,
    })),
    ...finalizedLogs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "finalized" as const,
      args: l.args,
    })),
    ...canceledLogs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "canceled" as const,
      args: l.args,
    })),
    ...updatedLogs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "updated" as const,
      args: l.args,
    })),
    ...invalidatedLogs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "invalidated" as const,
      args: l.args,
    })),
  ]
  applied.sort((a, b) => {
    const ab = a.blockNumber ?? 0n
    const bb = b.blockNumber ?? 0n
    if (ab !== bb) return ab > bb ? 1 : -1
    return (a.logIndex ?? 0) - (b.logIndex ?? 0)
  })

  for (const l of applied) {
    const auctionIdRaw = l.args.auctionId
    if (auctionIdRaw === undefined) continue
    const existing = byId.get(auctionIdRaw.toString())
    if (!existing) continue

    if (l.kind === "bid") {
      const args = l.args as (typeof bidLogs)[number]["args"]
      if (args.amount !== undefined) existing.currentBidWei = args.amount
      if (args.bidder !== undefined) {
        existing.currentBidder = args.bidder.toLowerCase()
      }
      if (args.endTime !== undefined) existing.endTime = Number(args.endTime)
    } else if (l.kind === "updated") {
      const args = l.args as (typeof updatedLogs)[number]["args"]
      if (args.reservePrice !== undefined) existing.reserveWei = args.reservePrice
    } else if (l.kind === "finalized") {
      existing.status = "settled"
    } else if (l.kind === "canceled") {
      existing.status = "cancelled"
    } else if (l.kind === "invalidated") {
      // Invalidated = the seller transferred / unapproved the NFT,
      // so the auction can no longer settle. Treat as cancelled.
      existing.status = "cancelled"
    }
  }

  // Backfill `creator` for active rows. Foundation NFTMarket is
  // generic over any ERC721; try `tokenCreator(uint256)` first
  // (Foundation's shared contract + some 3p contracts), fall back to
  // `owner()` (per-artist contracts under the Universal Deployer
  // convention have the artist as owner). Skip rows that already
  // have a creator from a prior scan pass.
  const needsCreator = [...byId.values()].filter(
    (r) => r.status === "active" && !r.creator,
  )
  // Multicall chunks. Single-batch eth_call response can exceed RPC
  // size limits when an artist has hundreds of auctions; chunk to a
  // safe size that consistently clears Alchemy / public RPC caps.
  const MULTICALL_CHUNK = 100
  for (let i = 0; i < needsCreator.length; i += MULTICALL_CHUNK) {
    const slice = needsCreator.slice(i, i + MULTICALL_CHUNK)
    try {
      const tcResults = await client.multicall({
        contracts: slice.map((r) => ({
          address: r.contract as Address,
          abi: tokenCreatorAbi,
          functionName: "tokenCreator" as const,
          args: [BigInt(r.tokenId)],
        })),
        allowFailure: true,
      })
      const ownerNeeded: number[] = []
      for (let j = 0; j < slice.length; j++) {
        const res = tcResults[j]
        if (res?.status === "success" && typeof res.result === "string") {
          slice[j].creator = (res.result as string).toLowerCase()
        } else {
          ownerNeeded.push(j)
        }
      }
      if (ownerNeeded.length > 0) {
        const ownerResults = await client.multicall({
          contracts: ownerNeeded.map((j) => ({
            address: slice[j].contract as Address,
            abi: ownerAbi,
            functionName: "owner" as const,
          })),
          allowFailure: true,
        })
        for (let k = 0; k < ownerNeeded.length; k++) {
          const res = ownerResults[k]
          if (res?.status === "success" && typeof res.result === "string") {
            slice[ownerNeeded[k]].creator = (
              res.result as string
            ).toLowerCase()
          }
        }
      }
    } catch {
      // Chunk failure leaves those rows null; next scan retries.
    }
  }

  if (byId.size > 0) {
    writeFoundationActiveAuctions([...byId.values()])
  }
  await writeFoundationArtistAuctionStatus(sellerLower)
}
