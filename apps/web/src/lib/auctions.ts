/**
 * Auction state lookups via direct RPC.
 *
 * Source-agnostic: a single token can have an active auction on either the
 * Foundation NFTMarket OR a PND auction house. Since the NFT is escrowed in
 * the auction contract, only one source can be active at a time. We probe both
 * in parallel and return whichever has the auction.
 */
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { erc721Abi, nftMarketAbi, pndAuctionHouseAbi, pndAuctionHouseFactoryAbi } from "@pin/abi"
import {
  NFT_MARKET,
  MAINNET_CHAIN_ID,
  PND_AUCTION_HOUSE_FACTORY,
  getAddressOrNull,
} from "@pin/addresses"
import { resolveDisplayNames } from "./artist-queries"

const FND_MARKET = NFT_MARKET[MAINNET_CHAIN_ID]
const PND_FACTORY = getAddressOrNull(PND_AUCTION_HOUSE_FACTORY, MAINNET_CHAIN_ID)
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * Normalized fee breakdown for an auction. Same shape regardless of source.
 */
export type AuctionFees = {
  /** Human label for the fee taker, e.g. "Foundation" or "PND". */
  platformLabel: string
  /** Basis points (1% = 100). Computed from the contract's fee call at the current price. */
  protocolFeeBps: number
  /** Basis points of creator royalty applied to this token (0 if none/primary). */
  creatorRoyaltyBps: number
  /** Basis points the seller nets after fees + royalty. */
  sellerBps: number
}

export type BidHistoryEntry = {
  bidder: Address
  bidderDisplay: string
  amount: bigint
  blockTime: number
  txHash: string
}

export type AuctionSource = "foundation" | "pnd"

/**
 * Shared shape for both Foundation and PND auctions. The `source` discriminator
 * tells the panel which contract + ABI to dispatch write calls against; the
 * `marketAddress` is the contract that holds the auction.
 */
export type AuctionState = {
  source: AuctionSource
  /** Contract address that holds this auction (for write calls). */
  marketAddress: Address
  auctionId: string
  nftContract: Address
  tokenId: string
  seller: Address
  sellerDisplay: string
  /** Reserve price before any bids; current high bid after. */
  amount: bigint
  /** Zero address until the first bid is placed. */
  bidder: Address
  /** ENS or truncated display for the current bidder. Empty when no bids. */
  bidderDisplay: string
  /** Zero until the first bid is placed; then now+duration, extended by late bids. */
  endTime: bigint
  duration: bigint
  /** Canonical minimum next-bid amount, sourced from the contract. */
  minBidWei: bigint
  /** Derived flag: auction created but no bids yet (timer not started). */
  awaitingFirstBid: boolean
  /** Derived flag: endTime has passed but tx hasn't been finalized. */
  awaitingSettlement: boolean
  /** Fee breakdown at the current effective price. Null if fee call failed. */
  fees: AuctionFees | null
  /** Newest-first bid history with ENS-resolved display names. */
  bidHistory: BidHistoryEntry[]
}

/** @deprecated Use AuctionState. Kept temporarily for callers in flight. */
export type FoundationAuctionState = AuctionState & { source: "foundation" }

const fndBidPlacedEvent = parseAbiItem(
  "event ReserveAuctionBidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 endTime)",
)
const pndBidPlacedEvent = parseAbiItem(
  "event AuctionBid(uint256 indexed auctionId, address indexed bidder, uint256 amount, bool firstBid, bool extended)",
)

/** NFTMarket proxy was deployed Dec 2021. Anything earlier can't have bids. */
const FND_MARKET_DEPLOY_BLOCK = 13_840_000n

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ?? "https://eth.llamarpc.com",
    ),
  })
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Probe both Foundation and PND auction sources for the given token. Returns
 * whichever has an active auction, or null if neither does. Both probes run in
 * parallel so latency = max(both), not sum.
 */
export async function getAuctionForToken(
  nftContract: string,
  tokenId: string,
): Promise<AuctionState | null> {
  const [foundation, pnd] = await Promise.all([
    getFoundationAuction(nftContract, tokenId),
    getPndAuctionForToken(nftContract, tokenId),
  ])
  // An NFT can only be escrowed in one place; if both somehow returned a
  // result (impossible barring contract bug), prefer Foundation since legacy
  // auctions are the existing user expectation.
  return foundation ?? pnd
}

// ─── Foundation source ──────────────────────────────────────────────────────

export async function getFoundationAuction(
  nftContract: string,
  tokenId: string,
): Promise<AuctionState | null> {
  const client = getClient()
  const contract = nftContract as Address

  let auctionId: bigint
  try {
    auctionId = await client.readContract({
      address: FND_MARKET,
      abi: nftMarketAbi,
      functionName: "getReserveAuctionIdFor",
      args: [contract, BigInt(tokenId)],
    })
  } catch {
    return null
  }

  if (auctionId === 0n) return null

  let auction: {
    nftContract: Address
    tokenId: bigint
    seller: Address
    duration: bigint
    extensionDuration: bigint
    endTime: bigint
    bidder: Address
    amount: bigint
  }
  try {
    auction = await client.readContract({
      address: FND_MARKET,
      abi: nftMarketAbi,
      functionName: "getReserveAuction",
      args: [auctionId],
    })
  } catch {
    return null
  }

  if (auction.seller === ZERO_ADDRESS) return null

  let minBidWei: bigint
  try {
    minBidWei = await client.readContract({
      address: FND_MARKET,
      abi: nftMarketAbi,
      functionName: "getMinBidAmount",
      args: [auctionId],
    })
  } catch {
    minBidWei = auction.amount
  }

  const pricedAt = auction.amount > 0n ? auction.amount : minBidWei

  const [fees, rawHistory] = await Promise.all([
    getFoundationFees(client, auction.nftContract, auction.tokenId, pricedAt),
    getFoundationBidHistory(client, auctionId),
  ])

  const awaitingFirstBid =
    auction.endTime === 0n || auction.bidder === ZERO_ADDRESS
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement =
    !awaitingFirstBid && auction.endTime > 0n && auction.endTime <= nowSec

  const addressesToResolve: string[] = [auction.seller]
  if (auction.bidder !== ZERO_ADDRESS) addressesToResolve.push(auction.bidder)
  for (const b of rawHistory) addressesToResolve.push(b.bidder)
  const names = await resolveDisplayNames(addressesToResolve)
  const lookup = (a: Address) => names.get(a.toLowerCase()) ?? a

  return {
    source: "foundation",
    marketAddress: FND_MARKET,
    auctionId: auctionId.toString(),
    nftContract: auction.nftContract,
    tokenId: auction.tokenId.toString(),
    seller: auction.seller,
    sellerDisplay: lookup(auction.seller),
    amount: auction.amount,
    bidder: auction.bidder,
    bidderDisplay:
      auction.bidder === ZERO_ADDRESS ? "" : lookup(auction.bidder),
    endTime: auction.endTime,
    duration: auction.duration,
    minBidWei,
    awaitingFirstBid,
    awaitingSettlement,
    fees,
    bidHistory: rawHistory.map((b) => ({ ...b, bidderDisplay: lookup(b.bidder) })),
  }
}

async function getFoundationBidHistory(
  client: ReturnType<typeof createPublicClient>,
  auctionId: bigint,
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
  const logs = await client
    .getLogs({
      address: FND_MARKET,
      event: fndBidPlacedEvent,
      args: { auctionId },
      fromBlock: FND_MARKET_DEPLOY_BLOCK,
      toBlock: "latest",
    })
    .catch(() => [])

  return enrichBidLogs(client, logs, "amount")
}

async function getFoundationFees(
  client: ReturnType<typeof createPublicClient>,
  nftContract: Address,
  tokenId: bigint,
  price: bigint,
): Promise<AuctionFees | null> {
  if (price === 0n) return null
  try {
    const [totalFees, creatorRev, , , sellerRev] = await client.readContract({
      address: FND_MARKET,
      abi: nftMarketAbi,
      functionName: "getFeesAndRecipients",
      args: [nftContract, tokenId, price],
    })

    return {
      platformLabel: "Foundation",
      protocolFeeBps: weiToBps(totalFees, price),
      creatorRoyaltyBps: weiToBps(creatorRev, price),
      sellerBps: weiToBps(sellerRev, price),
    }
  } catch {
    return null
  }
}

// ─── PND source ─────────────────────────────────────────────────────────────

/**
 * Find a PND auction for the given token, if any. Strategy:
 *   1. If no factory deployed yet (zero address), short-circuit.
 *   2. Read the NFT's current owner. If it's a PND house (registered with the
 *      factory), the token is escrowed there and that house has the auction.
 *   3. Read the auctionId from the house and build the auction state.
 */
async function getPndAuctionForToken(
  nftContract: string,
  tokenId: string,
): Promise<AuctionState | null> {
  if (!PND_FACTORY) return null
  const client = getClient()
  const contract = nftContract as Address
  const tokenIdBig = BigInt(tokenId)

  let currentOwner: Address
  try {
    currentOwner = await client.readContract({
      address: contract,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [tokenIdBig],
    })
  } catch {
    return null
  }

  // If the token isn't escrowed in a PND house, there's no PND auction.
  let isPndHouse: boolean
  try {
    isPndHouse = await client.readContract({
      address: PND_FACTORY,
      abi: pndAuctionHouseFactoryAbi,
      functionName: "isHouse",
      args: [currentOwner],
    })
  } catch {
    return null
  }
  if (!isPndHouse) return null

  return readPndAuction(client, currentOwner, contract, tokenIdBig)
}

/**
 * Build the full PND auction state given the house address that holds it.
 * Exposed because callers that already know the house (e.g. an artist gallery
 * page that fetched it once) can skip the ownerOf+isHouse round-trip.
 */
export async function getPndAuctionByHouse(
  houseAddress: Address,
  nftContract: string,
  tokenId: string,
): Promise<AuctionState | null> {
  const client = getClient()
  return readPndAuction(client, houseAddress, nftContract as Address, BigInt(tokenId))
}

async function readPndAuction(
  client: ReturnType<typeof createPublicClient>,
  houseAddress: Address,
  contract: Address,
  tokenIdBig: bigint,
): Promise<AuctionState | null> {
  let auctionId: bigint
  try {
    auctionId = await client.readContract({
      address: houseAddress,
      abi: pndAuctionHouseAbi,
      functionName: "getAuctionIdFor",
      args: [contract, tokenIdBig],
    })
  } catch {
    return null
  }

  // The house uses 0 as a valid auctionId, so we also check existence below.
  let auction: readonly [
    bigint, Address, boolean, bigint, bigint, bigint, bigint, number, Address, Address, Address,
  ]
  try {
    auction = (await client.readContract({
      address: houseAddress,
      abi: pndAuctionHouseAbi,
      functionName: "auctions",
      args: [auctionId],
    })) as typeof auction
  } catch {
    return null
  }

  const [
    auctionTokenId,
    auctionTokenContract,
    approved,
    amount,
    duration,
    firstBidTime,
    reservePrice,
    curatorFeeBps,
    tokenOwner,
    bidder,
    curator,
  ] = auction

  if (tokenOwner === ZERO_ADDRESS) return null
  // The auction must reference the token we asked about (defensive — should
  // always be true given the lookup, but cheap to verify).
  if (
    auctionTokenContract.toLowerCase() !== contract.toLowerCase() ||
    auctionTokenId !== tokenIdBig
  ) {
    return null
  }

  const minBidWei = await client
    .readContract({
      address: houseAddress,
      abi: pndAuctionHouseAbi,
      functionName: "getMinBidAmount",
      args: [auctionId],
    })
    .catch(() => (amount === 0n ? reservePrice : amount))

  const pricedAt = amount > 0n ? amount : reservePrice

  // PND fees: protocolFeeBps from contract + curatorFeeBps from auction. No
  // ERC2981 royalty path in v1.
  const protocolFeeBps = await client
    .readContract({
      address: houseAddress,
      abi: pndAuctionHouseAbi,
      functionName: "protocolFeeBps",
    })
    .catch(() => 0)
  const protoBps = Number(protocolFeeBps)
  const curBps = Number(curatorFeeBps)
  // Curator fee is taken from the post-protocol-fee remainder, matching the
  // contract's _refund order. Approximate as bps for display.
  const afterProtoBps = 10000 - protoBps
  const curatorEffectiveBps = Math.floor((afterProtoBps * curBps) / 10000)
  const sellerBps = afterProtoBps - curatorEffectiveBps

  const fees: AuctionFees = {
    platformLabel: "PND",
    protocolFeeBps: protoBps,
    creatorRoyaltyBps: 0,
    sellerBps,
  }
  // Stash the curator fee into creatorRoyaltyBps so the existing UI line
  // ("Curator royalty") renders. The label is still meaningful for PND since
  // a curator IS distinct from the seller when set.
  if (curatorEffectiveBps > 0) fees.creatorRoyaltyBps = curatorEffectiveBps

  const rawHistory = await getPndBidHistory(client, houseAddress, auctionId)

  const awaitingFirstBid = firstBidTime === 0n || bidder === ZERO_ADDRESS
  const endTime = firstBidTime === 0n ? 0n : firstBidTime + duration
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement =
    !awaitingFirstBid && endTime > 0n && endTime <= nowSec

  const addressesToResolve: string[] = [tokenOwner]
  if (bidder !== ZERO_ADDRESS) addressesToResolve.push(bidder)
  for (const b of rawHistory) addressesToResolve.push(b.bidder)
  const names = await resolveDisplayNames(addressesToResolve)
  const lookup = (a: Address) => names.get(a.toLowerCase()) ?? a

  // Suppress unused variable warning for fields we capture but don't surface
  // in v1 (approved, reservePrice — already folded into amount/minBidWei).
  void approved
  void reservePrice
  void curator
  void pricedAt

  return {
    source: "pnd",
    marketAddress: houseAddress,
    auctionId: auctionId.toString(),
    nftContract: auctionTokenContract,
    tokenId: auctionTokenId.toString(),
    seller: tokenOwner,
    sellerDisplay: lookup(tokenOwner),
    amount,
    bidder,
    bidderDisplay: bidder === ZERO_ADDRESS ? "" : lookup(bidder),
    endTime,
    duration,
    minBidWei,
    awaitingFirstBid,
    awaitingSettlement,
    fees,
    bidHistory: rawHistory.map((b) => ({ ...b, bidderDisplay: lookup(b.bidder) })),
  }
}

async function getPndBidHistory(
  client: ReturnType<typeof createPublicClient>,
  houseAddress: Address,
  auctionId: bigint,
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
  const logs = await client
    .getLogs({
      address: houseAddress,
      event: pndBidPlacedEvent,
      args: { auctionId },
      fromBlock: 0n,
      toBlock: "latest",
    })
    .catch(() => [])

  return enrichBidLogs(client, logs, "amount")
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

async function enrichBidLogs(
  client: ReturnType<typeof createPublicClient>,
  logs: ReadonlyArray<{
    args: { bidder?: Address; amount?: bigint }
    blockNumber: bigint | null
    transactionHash: `0x${string}` | null
  }>,
  _amountField: "amount",
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
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

  const entries = logs
    .filter(
      (l): l is typeof l & { blockNumber: bigint; transactionHash: `0x${string}` } =>
        l.blockNumber !== null && l.transactionHash !== null,
    )
    .map((l) => ({
      bidder: l.args.bidder as Address,
      amount: l.args.amount as bigint,
      blockTime: blockTimes.get(l.blockNumber) ?? 0,
      txHash: l.transactionHash,
    }))

  entries.sort((a, b) => b.blockTime - a.blockTime)
  return entries
}

function weiToBps(part: bigint, total: bigint): number {
  if (total === 0n) return 0
  return Number((part * 10000n) / total)
}
