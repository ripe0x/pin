/**
 * Types, event ABIs, and pure decode/derivation logic shared by
 * `lib/auctions.ts` (the server-only cached chain reads) and any client
 * component that needs the same shapes. Mirrors the split already used for
 * `lib/surface.ts` vs `lib/collection.ts`: no `server-only` import here, so
 * this module can be imported directly by client components and by tests
 * without pulling in Next's server-only guard.
 */
import { parseAbiItem, type Address } from "viem"
import { getLogsChunked } from "./rpc"
import { ZERO_ADDRESS } from "./config"

// ─── Event ABIs ─────────────────────────────────────────────────────────────

// Identical on both factory generations.
export const auctionHouseCreatedEvent = parseAbiItem(
  "event AuctionHouseCreated(address indexed owner, address indexed house, address feeRecipient, uint16 protocolFeeBps)",
)

// V1's AuctionCreated has no fundsRecipient/listingExpiry fields.
export const v1AuctionCreatedEvent = parseAbiItem(
  "event AuctionCreated(uint256 indexed auctionId, uint256 indexed tokenId, address indexed tokenContract, uint256 duration, uint256 reservePrice, address tokenOwner)",
)
// AuctionBid, AuctionEnded, and AuctionCanceled are byte-identical between
// house versions, so one parsed event covers both.
export const auctionBidEvent = parseAbiItem(
  "event AuctionBid(uint256 indexed auctionId, address indexed bidder, uint256 amount, bool firstBid, bool extended)",
)
export const auctionEndedEvent = parseAbiItem(
  "event AuctionEnded(uint256 indexed auctionId, address tokenOwner, address winner, uint256 sellerProceeds, uint256 protocolFee)",
)
export const auctionCanceledEvent = parseAbiItem(
  "event AuctionCanceled(uint256 indexed auctionId)",
)

// V2 adds fundsRecipient + listingExpiry to listing creation, a dedicated
// 1155 creation event, and the deferred-delivery/unwind lifecycle events.
export const v2AuctionCreatedEvent = parseAbiItem(
  "event AuctionCreated(uint256 indexed auctionId, uint256 indexed tokenId, address indexed tokenContract, uint256 duration, uint256 reservePrice, address tokenOwner, address fundsRecipient, uint64 listingExpiry)",
)
export const v2Auction1155CreatedEvent = parseAbiItem(
  "event Auction1155Created(uint256 indexed auctionId, uint256 indexed tokenId, address indexed tokenContract, uint256 quantity, uint256 duration, uint256 reservePrice, address tokenOwner, address fundsRecipient, uint64 listingExpiry)",
)
export const v2LotUnwoundEvent = parseAbiItem(
  "event LotUnwound(uint256 indexed auctionId, address indexed winner, uint256 refundAmount, address tokenOwner)",
)

// ─── Types ──────────────────────────────────────────────────────────────────

export type HouseVersion = 1 | 2
export type TokenStandard = "erc721" | "erc1155"

/**
 * V1's set is live/upcoming/settled/cancelled. V2 adds three states, all
 * reachable only from a delivery failure at settlement: "deferred" (delivery
 * to the winner failed, nobody paid yet, retryable via claimLot), "unwound"
 * (unwindStuckLot refunded the winner and returned the lot, terminal), and
 * "unwound_return_pending" (unwound, but the lot's return to the seller also
 * failed, awaiting returnUnwoundLot).
 */
export type AuctionStatus =
  | "live"
  | "upcoming"
  | "settled"
  | "cancelled"
  | "deferred"
  | "unwound"
  | "unwound_return_pending"

export type AuctionSummary = {
  auctionId: string
  house: Address
  houseVersion: HouseVersion
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
  /** Proceeds recipient. V1 pays tokenOwner directly, so this equals tokenOwner there. */
  fundsRecipient: Address
  standard: TokenStandard
  /** ERC1155 lot size; "1" for ERC721 and for every V1 auction. */
  quantity: string
  /** V2 no-bid listing close date, unix seconds; "0" means none and is always "0" for V1. */
  listingExpiry: string
  status: AuctionStatus
  /** For settled auctions: final sale price in wei. Empty otherwise. */
  finalPrice?: string
  /** For settled, unwound, deferred, or return-pending auctions: the winning bidder. */
  winner?: Address
  /** V2 only, status "deferred": block time DeliveryDeferred fired. */
  deferredAt?: string
  /** V2 only, status "unwound" or "unwound_return_pending": amount refunded to the winner. */
  refundAmount?: string
}

export type BidEntry = {
  bidder: Address
  amount: string
  blockTime: number
  txHash: `0x${string}`
}

// ─── Route identity ─────────────────────────────────────────────────────────

/**
 * URL id for an auction. A bare number means V1, matching every link an
 * artist has already shared before V2 existed. A `v2-` prefix disambiguates
 * a V2 auction whose numeric id collides with a V1 one, since each house
 * numbers its own auctions from zero independently.
 */
export function auctionRouteId(auction: {
  auctionId: string
  houseVersion: HouseVersion
}): string {
  return auction.houseVersion === 2 ? `v2-${auction.auctionId}` : auction.auctionId
}

export function parseAuctionRouteId(
  routeId: string,
): { houseVersion: HouseVersion; auctionId: string } | null {
  if (routeId.startsWith("v2-")) {
    const rest = routeId.slice(3)
    return /^\d+$/.test(rest) ? { houseVersion: 2, auctionId: rest } : null
  }
  return /^\d+$/.test(routeId) ? { houseVersion: 1, auctionId: routeId } : null
}

// ─── House resolution ───────────────────────────────────────────────────────

export type HouseRef = { address: Address; version: HouseVersion }

export type ArtistHouses = {
  v1: Address | null
  v2: Address | null
  /** Every house the artist holds, newest generation first. Empty means no house at all. */
  all: HouseRef[]
}

/**
 * Combines the two independent factory lookups into one view. Pure so the
 * V1-only / V2-only / both cases are unit-testable without a chain client.
 */
export function mergeArtistHouses(
  v1: Address | null,
  v2: Address | null,
): ArtistHouses {
  const all: HouseRef[] = []
  if (v2) all.push({ address: v2, version: 2 })
  if (v1) all.push({ address: v1, version: 1 })
  return { v1, v2, all }
}

// ─── V2 event decode ────────────────────────────────────────────────────────

export type V2HouseEventData = {
  created: Record<
    string,
    {
      tokenContract: Address
      tokenId: string
      reservePrice: string
      duration: string
      tokenOwner: Address
      fundsRecipient: Address
      standard: TokenStandard
      quantity: string
      listingExpiry: string
    }
  >
  settled: Record<string, { winner: Address; sellerProceeds: string; protocolFee: string }>
  cancelled: string[]
  /** unwindStuckLot's terminal outcome: winner refunded, lot returned. */
  unwound: Record<string, { winner: Address; refundAmount: string; tokenOwner: Address }>
}

/**
 * Decodes a raw event log batch from a V2 house into the four lifecycle
 * buckets. Pure: takes already-fetched logs, so it's testable without a
 * chain client.
 */
export function decodeV2HouseLogs(
  logs: readonly { eventName?: string; args: Record<string, unknown> }[],
): V2HouseEventData {
  const data: V2HouseEventData = { created: {}, settled: {}, cancelled: [], unwound: {} }
  for (const log of logs) {
    const args = log.args
    if (log.eventName === "AuctionCreated") {
      const id = args.auctionId as bigint | undefined
      if (id === undefined) continue
      data.created[id.toString()] = {
        tokenContract: (args.tokenContract ?? ZERO_ADDRESS) as Address,
        tokenId: ((args.tokenId ?? 0n) as bigint).toString(),
        reservePrice: ((args.reservePrice ?? 0n) as bigint).toString(),
        duration: ((args.duration ?? 0n) as bigint).toString(),
        tokenOwner: (args.tokenOwner ?? ZERO_ADDRESS) as Address,
        fundsRecipient: (args.fundsRecipient ?? ZERO_ADDRESS) as Address,
        standard: "erc721",
        quantity: "1",
        listingExpiry: ((args.listingExpiry ?? 0n) as bigint).toString(),
      }
    } else if (log.eventName === "Auction1155Created") {
      const id = args.auctionId as bigint | undefined
      if (id === undefined) continue
      data.created[id.toString()] = {
        tokenContract: (args.tokenContract ?? ZERO_ADDRESS) as Address,
        tokenId: ((args.tokenId ?? 0n) as bigint).toString(),
        reservePrice: ((args.reservePrice ?? 0n) as bigint).toString(),
        duration: ((args.duration ?? 0n) as bigint).toString(),
        tokenOwner: (args.tokenOwner ?? ZERO_ADDRESS) as Address,
        fundsRecipient: (args.fundsRecipient ?? ZERO_ADDRESS) as Address,
        standard: "erc1155",
        quantity: ((args.quantity ?? 1n) as bigint).toString(),
        listingExpiry: ((args.listingExpiry ?? 0n) as bigint).toString(),
      }
    } else if (log.eventName === "AuctionEnded") {
      const id = args.auctionId as bigint | undefined
      if (id === undefined) continue
      data.settled[id.toString()] = {
        winner: (args.winner ?? ZERO_ADDRESS) as Address,
        sellerProceeds: ((args.sellerProceeds ?? 0n) as bigint).toString(),
        protocolFee: ((args.protocolFee ?? 0n) as bigint).toString(),
      }
    } else if (log.eventName === "AuctionCanceled") {
      const id = args.auctionId as bigint | undefined
      if (id !== undefined) data.cancelled.push(id.toString())
    } else if (log.eventName === "LotUnwound") {
      const id = args.auctionId as bigint | undefined
      if (id === undefined) continue
      data.unwound[id.toString()] = {
        winner: (args.winner ?? ZERO_ADDRESS) as Address,
        refundAmount: ((args.refundAmount ?? 0n) as bigint).toString(),
        tokenOwner: (args.tokenOwner ?? ZERO_ADDRESS) as Address,
      }
    }
  }
  return data
}

/**
 * Plain fetch + decode for a V2 house's lifecycle events, not wrapped in
 * `unstable_cache`. The caching wrapper lives in `lib/auctions.ts` since
 * `unstable_cache` needs a server-only context. Exercised directly in tests
 * with `./rpc`'s `getLogsChunked` mocked.
 */
export async function fetchV2HouseEventData(
  house: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<V2HouseEventData> {
  const logs = await getLogsChunked({
    address: house,
    events: [
      v2AuctionCreatedEvent,
      v2Auction1155CreatedEvent,
      auctionEndedEvent,
      auctionCanceledEvent,
      v2LotUnwoundEvent,
    ] as const,
    fromBlock,
    toBlock,
  })
  return decodeV2HouseLogs(logs)
}

// ─── V2 live-storage classification ─────────────────────────────────────────

export type V2LiveFlags = {
  pendingDelivery: boolean
  pendingReturn: boolean
  deferredAt: bigint
  listingExpiry: bigint
}

/**
 * Classifies a V2 auction whose storage is still populated. pendingReturn
 * and pendingDelivery are mutually exclusive on the contract: unwindStuckLot
 * clears pendingDelivery in the same call that may set pendingReturn. Pure,
 * so the derivation is testable without a chain client.
 */
export function classifyV2LiveAuction(
  firstBidTime: bigint,
  flags: Pick<V2LiveFlags, "pendingDelivery" | "pendingReturn">,
): { status: AuctionStatus; deferredAt?: bigint } {
  if (flags.pendingReturn) return { status: "unwound_return_pending" }
  if (flags.pendingDelivery) return { status: "deferred" }
  return { status: firstBidTime === 0n ? "upcoming" : "live" }
}
