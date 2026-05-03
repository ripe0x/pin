import "server-only"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { TL_AUCTION_HOUSE, MAINNET_CHAIN_ID } from "@pin/addresses"
import {
  writeTransientActiveAuctions,
  readTransientArtistAuctionStatus,
  writeTransientArtistAuctionStatus,
  LAZY_TTL,
  isFresh,
  type LazyTransientActiveAuction,
} from "../lazy-index"

const TL_AH = TL_AUCTION_HOUSE[MAINNET_CHAIN_ID]
// Auction House v2.6.1 was deployed in early 2026. Per-artist
// `getLogs` calls filter on indexed sender / nftAddress / tokenId
// topics, so the RPC returns only this artist's events regardless of
// how wide the block range is.
const TL_AUCTION_HOUSE_DEPLOY_BLOCK = 24_500_000n
const COOLDOWN_MS = LAZY_TTL.transientArtistAuctions

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

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.ALCHEMY_MAINNET_URL ??
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

function tokenKey(contract: string, tokenId: string): string {
  return `${contract.toLowerCase()}:${tokenId}`
}

/**
 * Lazy-index this artist's TL Auction House listings.
 *
 * Two-phase event walk, per-artist:
 *
 *   1. `ListingConfigured` filtered by `sender=artist` (indexed
 *      topic) — gives every listing this artist has configured.
 *      Captures the full `listing` tuple at creation time.
 *   2. For the union of (nftAddress, tokenId) pairs collected above,
 *      run `AuctionBid` / `AuctionSettled` / `BuyNowFulfilled` /
 *      `ListingCanceled` in parallel, filtered by `nftAddress` +
 *      `tokenId` arrays. The listing tuple on every event carries
 *      the current state, so the reducer just walks events in order
 *      and keeps the latest tuple per token.
 *
 * Reduces the union of events to current state and upserts into
 * `lazy_tl_active_auctions`. Stamps the artist's status row at the
 * end so the home grid's 24h freshness join surfaces them. Self-cools
 * via `LAZY_TTL.transientArtistAuctions` (2 min).
 */
export async function discoverTransientArtistAuctions(
  artist: Address,
): Promise<void> {
  const status = await readTransientArtistAuctionStatus(artist)
  if (status && isFresh(status.lastIndexedAt, COOLDOWN_MS)) return

  const client = getClient()
  const fromBlock = TL_AUCTION_HOUSE_DEPLOY_BLOCK
  const sellerLower = artist.toLowerCase() as Address

  // Phase 1 — every listing this artist has configured.
  const configuredLogs = await client.getLogs({
    address: TL_AH,
    event: listingConfiguredEvent,
    args: { sender: sellerLower },
    fromBlock,
  })

  if (configuredLogs.length === 0) {
    await writeTransientArtistAuctionStatus(sellerLower)
    return
  }

  const byKey = new Map<string, LazyTransientActiveAuction>()
  const nftAddressesSet = new Set<Address>()
  const tokenIdsSet = new Set<bigint>()

  type AppliedLog = {
    blockNumber: bigint | null
    logIndex: number | null
    kind: "configured" | "bid" | "settled" | "buyNow" | "cancel"
    nftAddress: string
    tokenId: string
    listing: ListingTuple
  }
  const applied: AppliedLog[] = []

  for (const l of configuredLogs) {
    const nftAddress = l.args.nftAddress?.toLowerCase()
    const tokenIdRaw = l.args.tokenId
    const listing = l.args.listing as ListingTuple | undefined
    if (!nftAddress || tokenIdRaw === undefined || !listing) continue
    nftAddressesSet.add(l.args.nftAddress as Address)
    tokenIdsSet.add(tokenIdRaw)
    applied.push({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "configured",
      nftAddress,
      tokenId: tokenIdRaw.toString(),
      listing,
    })
  }

  if (nftAddressesSet.size === 0) {
    await writeTransientArtistAuctionStatus(sellerLower)
    return
  }

  const nftAddresses = Array.from(nftAddressesSet)
  const tokenIds = Array.from(tokenIdsSet)

  // Phase 2 — Bid/Settled/BuyNow/Cancel filtered by (nftAddress,
  // tokenId). AND-across-fields topic filter can pick up another
  // artist's events for tokens whose contract+id parts overlap; we
  // discard those client-side via the `byKey` membership check.
  const [bidLogs, settledLogs, buyNowLogs, cancelLogs] = await Promise.all([
    client.getLogs({
      address: TL_AH,
      event: auctionBidEvent,
      args: { nftAddress: nftAddresses, tokenId: tokenIds },
      fromBlock,
    }),
    client.getLogs({
      address: TL_AH,
      event: auctionSettledEvent,
      args: { nftAddress: nftAddresses, tokenId: tokenIds },
      fromBlock,
    }),
    client.getLogs({
      address: TL_AH,
      event: buyNowFulfilledEvent,
      args: { nftAddress: nftAddresses, tokenId: tokenIds },
      fromBlock,
    }),
    client.getLogs({
      address: TL_AH,
      event: listingCanceledEvent,
      args: { nftAddress: nftAddresses, tokenId: tokenIds },
      fromBlock,
    }),
  ])

  for (const l of bidLogs) {
    const nftAddress = l.args.nftAddress?.toLowerCase()
    const tokenIdRaw = l.args.tokenId
    const listing = l.args.listing as ListingTuple | undefined
    if (!nftAddress || tokenIdRaw === undefined || !listing) continue
    applied.push({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "bid",
      nftAddress,
      tokenId: tokenIdRaw.toString(),
      listing,
    })
  }
  for (const l of settledLogs) {
    const nftAddress = l.args.nftAddress?.toLowerCase()
    const tokenIdRaw = l.args.tokenId
    const listing = l.args.listing as ListingTuple | undefined
    if (!nftAddress || tokenIdRaw === undefined || !listing) continue
    applied.push({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "settled",
      nftAddress,
      tokenId: tokenIdRaw.toString(),
      listing,
    })
  }
  for (const l of buyNowLogs) {
    const nftAddress = l.args.nftAddress?.toLowerCase()
    const tokenIdRaw = l.args.tokenId
    const listing = l.args.listing as ListingTuple | undefined
    if (!nftAddress || tokenIdRaw === undefined || !listing) continue
    applied.push({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "buyNow",
      nftAddress,
      tokenId: tokenIdRaw.toString(),
      listing,
    })
  }
  for (const l of cancelLogs) {
    const nftAddress = l.args.nftAddress?.toLowerCase()
    const tokenIdRaw = l.args.tokenId
    const listing = l.args.listing as ListingTuple | undefined
    if (!nftAddress || tokenIdRaw === undefined || !listing) continue
    applied.push({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      kind: "cancel",
      nftAddress,
      tokenId: tokenIdRaw.toString(),
      listing,
    })
  }

  applied.sort((a, b) => {
    const ab = a.blockNumber ?? 0n
    const bb = b.blockNumber ?? 0n
    if (ab !== bb) return ab > bb ? 1 : -1
    return (a.logIndex ?? 0) - (b.logIndex ?? 0)
  })

  for (const l of applied) {
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
    ] = l.listing
    const ethListing = currencyAddress.toLowerCase() === ETH_CURRENCY

    // For this artist's listings only — guard against AND-across
    // topic filter false positives. We trust ListingConfigured (the
    // sender filter is exact) and use the listing tuple's seller
    // for everything else.
    if (seller.toLowerCase() !== sellerLower) continue

    const key = tokenKey(l.nftAddress, l.tokenId)

    if (l.kind === "configured") {
      if (!ethListing) {
        if (byKey.has(key)) byKey.delete(key)
        continue
      }
      byKey.set(key, {
        contract: l.nftAddress,
        tokenId: l.tokenId,
        seller: sellerLower,
        reserveWei: reservePrice,
        currentBidWei: 0n,
        currentBidder: null,
        endTime: 0,
        status: "active",
        listingType: type_,
        startedAtBlock: l.blockNumber ?? 0n,
        creator: null,
      })
    } else {
      const existing = byKey.get(key)
      if (!existing) continue
      if (l.kind === "bid") {
        if (!ethListing) continue
        existing.currentBidWei = highestBid
        existing.currentBidder = highestBidder.toLowerCase()
        // TL's listing tuple carries the bid block's startTime, so
        // endTime = startTime + duration is exact (no chain-head
        // approximation needed).
        existing.endTime = Number(startTime + duration)
      } else if (l.kind === "settled") {
        existing.status = "settled"
      } else if (l.kind === "buyNow") {
        existing.status = "settled"
      } else if (l.kind === "cancel") {
        existing.status = "cancelled"
      }
    }
  }

  // Backfill `creator` for active rows. ERC721TL exposes
  // `tokenCreator(uint256)`; clones that don't fall back to `owner()`
  // (the per-artist contract owner is the artist by Universal
  // Deployer convention).
  const needsCreator = [...byKey.values()].filter(
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

  if (byKey.size > 0) {
    writeTransientActiveAuctions([...byKey.values()])
  }
  await writeTransientArtistAuctionStatus(sellerLower)
}
