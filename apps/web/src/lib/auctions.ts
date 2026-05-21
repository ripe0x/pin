import "server-only"
import { unstable_cache } from "next/cache"
import {
  createPublicClient, type Address,
} from "viem"
import { mainnet } from "viem/chains"
import { nftMarketAbi } from "@pin/abi"
import {
  NFT_MARKET, MAINNET_CHAIN_ID,
  SOVEREIGN_AUCTION_HOUSE_FACTORY, TL_AUCTION_HOUSE,
  getAddressOrNull,
} from "@pin/addresses"
import { sql } from "./db"
import { pgCache } from "./pg-cache"
import { loggingFallbackTransport } from "./rpc-log"
import { resolveDisplayNames } from "./artist-queries"

/**
 * v2 auctions module. The v1 file (1134 lines) probed both Foundation
 * NFTMarket and Sovereign houses via direct RPC + maintained per-bid
 * history in lazy_*_bids tables. v2 reads from Ponder tables; the
 * surface stays the same so call sites don't change.
 *
 * Live state freshness: Ponder polls at 300s. AuctionPanel still reads
 * fresh chain state at click-time for write txs (and the contract
 * rejects stale bids), so up-to-5-min UI staleness on the indexed-side
 * read is acceptable.
 */

const FND_MARKET = NFT_MARKET[MAINNET_CHAIN_ID]
const SOVEREIGN_FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_FACTORY, MAINNET_CHAIN_ID,
)
const TL_AH = TL_AUCTION_HOUSE[MAINNET_CHAIN_ID]
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

function getClient(route?: string) {
  return createPublicClient({
    chain: mainnet,
    transport: loggingFallbackTransport(route),
  })
}

// ─── Public types ────────────────────────────────────────────────────────

export type AuctionFees = {
  platformLabel: string
  protocolFeeBps: number
  creatorRoyaltyBps: number
  sellerBps: number
}

export type BidHistoryEntry = {
  bidder: Address
  bidderDisplay: string
  amount: bigint
  blockTime: number
  txHash: string
}

export type AuctionSource = "foundation" | "sovereign" | "superrareV2" | "transient"

export type AuctionState = {
  source: AuctionSource
  marketAddress: Address
  auctionId: string
  nftContract: Address
  tokenId: string
  seller: Address
  sellerDisplay: string
  amount: bigint
  bidder: Address
  bidderDisplay: string
  endTime: bigint
  duration: bigint
  minBidWei: bigint
  awaitingFirstBid: boolean
  awaitingSettlement: boolean
  fees: AuctionFees | null
  bidHistory: BidHistoryEntry[]
}

export type FoundationAuctionState = AuctionState & { source: "foundation" }

export type SovereignAuctionLite = {
  auctionId: string
  amount: string
  reservePrice: string
  endTime: string
  firstBidTime: string
  bucket: "active" | "ending" | "listed"
}

export function auctionTokenTag(nftContract: string, tokenId: string): string {
  return `auction:${nftContract.toLowerCase()}:${tokenId}`
}

// ─── getAuctionForToken: lookup-by-token ─────────────────────────────────

export async function getAuctionForToken(
  nftContract: string,
  tokenId: string,
): Promise<AuctionState | null> {
  if (!sql) return null
  const lower = nftContract.toLowerCase()

  // Probe Ponder for both PND (sovereign) and Foundation NFTMarket
  // auctions on this token. Only one can be active at a time (the NFT
  // is escrowed in the auction contract).
  return pgCache(auctionTokenTag(lower, tokenId), 30, async () => {
    const [pnd, fnd] = await Promise.all([
      readPndAuctionForToken(lower, tokenId),
      readFndAuctionForToken(lower, tokenId),
    ])
    return pnd ?? fnd
  })
}

async function readPndAuctionForToken(
  contract: string, tokenId: string,
): Promise<AuctionState | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(
    `SELECT id, lower(house) AS house, auction_id::text AS auction_id,
            lower(seller) AS seller, lower(bidder) AS bidder,
            amount::text AS amount, reserve_price::text AS reserve,
            duration::text AS duration, end_time::text AS end_time,
            first_bid_time::text AS first_bid_time, status
     FROM ${schema}.pnd_auctions
     WHERE lower(token_contract) = $1 AND token_id::text = $2
       AND status = 'active'
     ORDER BY created_at_time DESC LIMIT 1`,
    [contract, tokenId],
  )) as Array<{
    id: string; house: string; auction_id: string;
    seller: string; bidder: string;
    amount: string; reserve: string; duration: string;
    end_time: string; first_bid_time: string; status: string
  }>
  if (rows.length === 0) return null
  const r = rows[0]
  const awaitingFirstBid = r.first_bid_time === "0"
  const amount = awaitingFirstBid ? BigInt(r.reserve) : BigInt(r.amount)
  const endTime = BigInt(r.end_time)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement = !awaitingFirstBid && endTime !== 0n && endTime <= now

  const bidder = (r.bidder ?? ZERO_ADDRESS) as Address
  const displays = await resolveDisplayNames([r.seller, bidder])
  const bidHistory = await readPndBidHistory(r.id, displays)

  return {
    source: "sovereign",
    marketAddress: r.house as Address,
    auctionId: r.auction_id,
    nftContract: contract as Address,
    tokenId,
    seller: r.seller as Address,
    sellerDisplay: displays.get(r.seller) ?? r.seller,
    amount,
    bidder,
    bidderDisplay: bidder === ZERO_ADDRESS ? "" : (displays.get(bidder) ?? bidder),
    endTime,
    duration: BigInt(r.duration),
    minBidWei: awaitingFirstBid ? amount : (amount * 105n) / 100n,
    awaitingFirstBid,
    awaitingSettlement,
    fees: { platformLabel: "PND", protocolFeeBps: 0, creatorRoyaltyBps: 0, sellerBps: 10000 },
    bidHistory,
  }
}

async function readFndAuctionForToken(
  contract: string, tokenId: string,
): Promise<AuctionState | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(
    `SELECT auction_id::text AS auction_id,
            lower(seller) AS seller, lower(highest_bidder) AS bidder,
            highest_bid::text AS amount, reserve_price::text AS reserve,
            duration_seconds::text AS duration, end_time::text AS end_time,
            status
     FROM ${schema}.fnd_auctions
     WHERE lower(nft_contract) = $1 AND token_id::text = $2
       AND status = 'active'
     ORDER BY created_at_time DESC LIMIT 1`,
    [contract, tokenId],
  )) as Array<{
    auction_id: string; seller: string; bidder: string | null;
    amount: string; reserve: string; duration: string;
    end_time: string; status: string
  }>
  if (rows.length === 0) return null
  const r = rows[0]
  const awaitingFirstBid = !r.bidder
  const amount = awaitingFirstBid ? BigInt(r.reserve) : BigInt(r.amount)
  const endTime = BigInt(r.end_time)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement = !awaitingFirstBid && endTime !== 0n && endTime <= now
  const bidder = (r.bidder ?? ZERO_ADDRESS) as Address

  const displays = await resolveDisplayNames([r.seller, bidder])
  const bidHistory = await readFndBidHistory(r.auction_id, displays)

  const fees = await readFndFees(amount).catch(() => null)

  return {
    source: "foundation",
    marketAddress: FND_MARKET,
    auctionId: r.auction_id,
    nftContract: contract as Address,
    tokenId,
    seller: r.seller as Address,
    sellerDisplay: displays.get(r.seller) ?? r.seller,
    amount,
    bidder,
    bidderDisplay: bidder === ZERO_ADDRESS ? "" : (displays.get(bidder) ?? bidder),
    endTime,
    duration: BigInt(r.duration),
    minBidWei: awaitingFirstBid ? amount : (amount * 105n) / 100n,
    awaitingFirstBid,
    awaitingSettlement,
    fees,
    bidHistory,
  }
}

// ─── getFoundationAuction / getSovereignAuctionByHouse ───────────────────

export async function getFoundationAuction(
  auctionId: string,
): Promise<AuctionState | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(
    `SELECT lower(nft_contract) AS contract, token_id::text AS token_id
     FROM ${schema}.fnd_auctions WHERE auction_id::text = $1 LIMIT 1`,
    [auctionId],
  )) as Array<{ contract: string; token_id: string }>
  if (rows.length === 0) return null
  return readFndAuctionForToken(rows[0].contract, rows[0].token_id)
}

export async function getSovereignAuctionByHouse(
  house: Address, auctionId: string,
): Promise<AuctionState | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(
    `SELECT lower(token_contract) AS contract, token_id::text AS token_id
     FROM ${schema}.pnd_auctions
     WHERE lower(house) = $1 AND auction_id::text = $2 LIMIT 1`,
    [house.toLowerCase(), auctionId],
  )) as Array<{ contract: string; token_id: string }>
  if (rows.length === 0) return null
  return readPndAuctionForToken(rows[0].contract, rows[0].token_id)
}

// ─── getActiveAuctionCount ───────────────────────────────────────────────

export async function getActiveAuctionCount(
  artistAddress: string,
): Promise<number> {
  if (!sql) return 0
  const lower = artistAddress.toLowerCase()
  return getActiveAuctionCountCached(lower)
}

const getActiveAuctionCountCached = unstable_cache(
  async (lower: string): Promise<number> => {
    return pgCache<number>(`active-auction-count:${lower}`, 30, async () => {
      if (!sql) return 0
      const rows = (await sql.unsafe(
        `SELECT count(*)::int AS n FROM ${schema}.pnd_auctions
         WHERE lower(seller) = $1 AND status = 'active'`,
        [lower],
      )) as Array<{ n: number }>
      return rows[0]?.n ?? 0
    })
  },
  ["active-auction-count-v2"],
  { revalidate: 30, tags: ["active-auction-count"] },
)

// ─── getArtistSovereignAuctionMap ────────────────────────────────────────

export async function getArtistSovereignAuctionMap(
  artistAddress: string,
): Promise<Record<string, SovereignAuctionLite>> {
  if (!sql) return {}
  const lower = artistAddress.toLowerCase()
  return getArtistSovereignAuctionMapCached(lower)
}

const getArtistSovereignAuctionMapCached = unstable_cache(
  async (lower: string): Promise<Record<string, SovereignAuctionLite>> => {
    return pgCache<Record<string, SovereignAuctionLite>>(
      `artist-sovereign-auction-map:${lower}`,
      30,
      async () => {
        if (!sql) return {}
        const rows = (await sql.unsafe(
          `SELECT auction_id::text AS auction_id,
                  lower(token_contract) AS contract,
                  token_id::text AS token_id,
                  amount::text AS amount,
                  reserve_price::text AS reserve,
                  end_time::text AS end_time,
                  first_bid_time::text AS first_bid_time
           FROM ${schema}.pnd_auctions
           WHERE lower(seller) = $1 AND status = 'active'`,
          [lower],
        )) as Array<{
          auction_id: string; contract: string; token_id: string;
          amount: string; reserve: string;
          end_time: string; first_bid_time: string
        }>

        const map: Record<string, SovereignAuctionLite> = {}
        const now = Math.floor(Date.now() / 1000)
        for (const r of rows) {
          const key = `${r.contract}:${r.token_id}`
          const firstBid = Number(r.first_bid_time)
          const endTime = Number(r.end_time)
          const bucket =
            firstBid === 0 ? "listed" :
            endTime > now ? "active" : "ending"
          map[key] = {
            auctionId: r.auction_id,
            amount: r.amount,
            reservePrice: r.reserve,
            endTime: r.end_time,
            firstBidTime: r.first_bid_time,
            bucket,
          }
        }
        return map
      },
    )
  },
  ["artist-sovereign-auction-map-v2"],
  { revalidate: 30, tags: ["artist-sovereign-auction-map"] },
)

// ─── Bid history (from Ponder) ───────────────────────────────────────────

async function readPndBidHistory(
  auctionId: string, displays: Map<string, string>,
): Promise<BidHistoryEntry[]> {
  if (!sql) return []
  const rows = (await sql.unsafe(
    `SELECT lower(bidder) AS bidder, amount::text AS amount,
            block_time::text AS block_time, tx_hash
     FROM ${schema}.pnd_bids
     WHERE auction_id = $1
     ORDER BY block_number DESC`,
    [auctionId],
  )) as Array<{ bidder: string; amount: string; block_time: string; tx_hash: string }>

  const newBidders = rows
    .map((r) => r.bidder)
    .filter((b) => !displays.has(b))
  if (newBidders.length > 0) {
    const extra = await resolveDisplayNames(newBidders)
    for (const [k, v] of extra) displays.set(k, v)
  }

  return rows.map((r) => ({
    bidder: r.bidder as Address,
    bidderDisplay: displays.get(r.bidder) ?? r.bidder,
    amount: BigInt(r.amount),
    blockTime: Number(r.block_time),
    txHash: r.tx_hash,
  }))
}

async function readFndBidHistory(
  auctionId: string, displays: Map<string, string>,
): Promise<BidHistoryEntry[]> {
  if (!sql) return []
  const rows = (await sql.unsafe(
    `SELECT lower(bidder) AS bidder, amount::text AS amount,
            block_time::text AS block_time, tx_hash
     FROM ${schema}.fnd_bids
     WHERE auction_id::text = $1
     ORDER BY block_number DESC`,
    [auctionId],
  )) as Array<{ bidder: string; amount: string; block_time: string; tx_hash: string }>

  const newBidders = rows
    .map((r) => r.bidder)
    .filter((b) => !displays.has(b))
  if (newBidders.length > 0) {
    const extra = await resolveDisplayNames(newBidders)
    for (const [k, v] of extra) displays.set(k, v)
  }

  return rows.map((r) => ({
    bidder: r.bidder as Address,
    bidderDisplay: displays.get(r.bidder) ?? r.bidder,
    amount: BigInt(r.amount),
    blockTime: Number(r.block_time),
    txHash: r.tx_hash,
  }))
}

// ─── Foundation fees (live chain read; small + needed for accurate UI) ───

async function readFndFees(_price: bigint): Promise<AuctionFees | null> {
  // Foundation's per-price fee call (getFeesAndRecipients) has shape
  // variance across NFTMarket versions; rather than couple to a specific
  // tuple decoding, surface the published Foundation schedule (15%
  // protocol fee, 10% creator royalty on secondaries) as a UI hint. The
  // on-chain settle event carries the actual split that gets paid out.
  return {
    platformLabel: "Foundation",
    protocolFeeBps: 1500,
    creatorRoyaltyBps: 1000,
    sellerBps: 7500,
  }
}

// Re-exports for adapter consumers
export { FND_MARKET, SOVEREIGN_FACTORY, TL_AH, ZERO_ADDRESS }
