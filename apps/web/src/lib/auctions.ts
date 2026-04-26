/**
 * Auction state lookups via direct RPC.
 *
 * V1 supports read-only Foundation reserve auctions. PND-native auctions
 * will plug in here as a second source once the contracts ship.
 */
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"

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

export type FoundationAuctionState = {
  source: "foundation"
  auctionId: string
  nftContract: Address
  tokenId: string
  seller: Address
  /** Reserve price before any bids; current high bid after. */
  amount: bigint
  /** Zero address until the first bid is placed. */
  bidder: Address
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
}

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
  const fees = await getFoundationFees(
    client,
    auction.nftContract,
    auction.tokenId,
    pricedAt,
  )

  const awaitingFirstBid =
    auction.endTime === 0n || auction.bidder === ZERO_ADDRESS
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement =
    !awaitingFirstBid && auction.endTime > 0n && auction.endTime <= nowSec

  return {
    source: "foundation",
    auctionId: auctionId.toString(),
    nftContract: auction.nftContract,
    tokenId: auction.tokenId.toString(),
    seller: auction.seller,
    amount: auction.amount,
    bidder: auction.bidder,
    endTime: auction.endTime,
    duration: auction.duration,
    extensionDuration: auction.extensionDuration,
    minBidWei,
    awaitingFirstBid,
    awaitingSettlement,
    fees,
  }
}

async function getFoundationFees(
  client: ReturnType<typeof createPublicClient>,
  nftContract: Address,
  tokenId: string,
  price: bigint,
): Promise<AuctionFees | null> {
  if (price === 0n) return null
  try {
    const [totalFees, creatorRev, , , sellerRev] = await client.readContract({
      address: MARKET_ADDRESS,
      abi: nftMarketAbi,
      functionName: "getFeesAndRecipients",
      args: [nftContract, BigInt(tokenId), price],
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
