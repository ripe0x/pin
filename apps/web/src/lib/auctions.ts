/**
 * Auction state lookups via direct RPC.
 *
 * V1 supports read-only Foundation reserve auctions. PND-native auctions
 * will plug in here as a second source once the contracts ship.
 */
import { createPublicClient, http, parseAbiItem, type Address } from "viem"
import { mainnet } from "viem/chains"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import { resolveDisplayNames } from "./artist-queries"

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * Normalized fee breakdown for an auction. Same shape regardless of which
 * auction contract (Foundation, future PND) the auction lives in — the panel
 * renders this without knowing the source.
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

export type FoundationAuctionState = {
  source: "foundation"
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
  extensionDuration: bigint
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

const bidPlacedEvent = parseAbiItem(
  "event ReserveAuctionBidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 endTime)",
)

/** NFTMarket proxy was deployed Dec 2021. Anything earlier can't have bids. */
const NFT_MARKET_DEPLOY_BLOCK = 13_840_000n

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ?? "https://eth.llamarpc.com",
    ),
  })
}

export async function getFoundationAuction(
  nftContract: string,
  tokenId: string,
): Promise<FoundationAuctionState | null> {
  const client = getClient()
  const contract = nftContract as Address

  let auctionId: bigint
  try {
    auctionId = await client.readContract({
      address: MARKET_ADDRESS,
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
      address: MARKET_ADDRESS,
      abi: nftMarketAbi,
      functionName: "getReserveAuction",
      args: [auctionId],
    })
  } catch {
    return null
  }

  if (auction.seller === ZERO_ADDRESS) return null

  // Pull the canonical min-bid value from the contract rather than computing it
  // off-chain — keeps us aligned with whatever increment policy Foundation uses.
  let minBidWei: bigint
  try {
    minBidWei = await client.readContract({
      address: MARKET_ADDRESS,
      abi: nftMarketAbi,
      functionName: "getMinBidAmount",
      args: [auctionId],
    })
  } catch {
    minBidWei = auction.amount
  }

  // Use the prospective settlement price to compute fees. For an unbid auction
  // that's the reserve; for a live auction it's the current high bid. Foundation's
  // fee percentages don't change with price for a given token, so this is stable.
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

  // Resolve ENS for every distinct address we'll display (current bidder,
  // seller, and every bidder in history) in a single parallel batch.
  const addressesToResolve: string[] = [auction.seller]
  if (auction.bidder !== ZERO_ADDRESS) addressesToResolve.push(auction.bidder)
  for (const b of rawHistory) addressesToResolve.push(b.bidder)
  const names = await resolveDisplayNames(addressesToResolve)
  const lookup = (a: Address) => names.get(a.toLowerCase()) ?? a

  const bidHistory: BidHistoryEntry[] = rawHistory.map((b) => ({
    ...b,
    bidderDisplay: lookup(b.bidder),
  }))

  return {
    source: "foundation",
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
    extensionDuration: auction.extensionDuration,
    minBidWei,
    awaitingFirstBid,
    awaitingSettlement,
    fees,
    bidHistory,
  }
}

async function getFoundationBidHistory(
  client: ReturnType<typeof createPublicClient>,
  auctionId: bigint,
): Promise<Array<Omit<BidHistoryEntry, "bidderDisplay">>> {
  // Indexed auctionId topic makes this cheap even over the full deploy range.
  const logs = await client
    .getLogs({
      address: MARKET_ADDRESS,
      event: bidPlacedEvent,
      args: { auctionId },
      fromBlock: NFT_MARKET_DEPLOY_BLOCK,
      toBlock: "latest",
    })
    .catch(() => [])

  if (logs.length === 0) return []

  // Block timestamps in parallel (one block per bid; bid counts are tiny).
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

async function getFoundationFees(
  client: ReturnType<typeof createPublicClient>,
  nftContract: Address,
  tokenId: bigint,
  price: bigint,
): Promise<AuctionFees | null> {
  if (price === 0n) return null
  try {
    const [totalFees, creatorRev, , , sellerRev] = await client.readContract({
      address: MARKET_ADDRESS,
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

function weiToBps(part: bigint, total: bigint): number {
  if (total === 0n) return 0
  return Number((part * 10000n) / total)
}
