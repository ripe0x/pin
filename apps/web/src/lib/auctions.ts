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
import { toFndAuctionLite } from "./fnd-auction-lite"
import { INDEXER_SCHEMA as schema } from "./indexer-schema"

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
  // Sovereign house generation behind marketAddress; selects the write ABI
  // (V2 decodes its own custom errors). Always 1 for non-sovereign sources.
  houseVersion: 1 | 2
  tokenStandard: "erc721" | "erc1155"
  // ERC1155 lot size; 1 for ERC721.
  quantity: bigint
  // V2 only: proceeds recipient recorded at listing time. Null for V1.
  fundsRecipient: Address | null
  // V2 only: no-bid listing close date (0n = none). 0n for V1.
  listingExpiry: bigint
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

// pnd_auctions gained version/standard/quantity with the V2 indexer
// schema. Until that schema bump reaches prod, selecting them errors the
// whole query, so probe once per process and degrade to V1 defaults.
let v2ColumnsPromise: Promise<boolean> | null = null
function hasV2AuctionColumns(): Promise<boolean> {
  if (!sql) return Promise.resolve(false)
  const db = sql
  if (!v2ColumnsPromise) {
    v2ColumnsPromise = db
      .unsafe(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'pnd_auctions'
           AND column_name = 'version'`,
        [schema],
      )
      .then((rows) => (rows as unknown[]).length > 0)
      .catch(() => {
        v2ColumnsPromise = null
        return false
      })
  }
  return v2ColumnsPromise
}

type V2Cols = {
  version?: number
  standard?: string
  quantity?: string
  funds_recipient?: string | null
  listing_expiry?: string | null
}
function v2ColFields(r: V2Cols): {
  houseVersion: 1 | 2
  tokenStandard: "erc721" | "erc1155"
  quantity: bigint
  fundsRecipient: Address | null
  listingExpiry: bigint
} {
  return {
    houseVersion: r.version === 2 ? 2 : 1,
    tokenStandard: r.standard === "erc1155" ? "erc1155" : "erc721",
    quantity: BigInt(r.quantity ?? "1"),
    fundsRecipient:
      r.funds_recipient && r.funds_recipient !== ZERO_ADDRESS
        ? (r.funds_recipient as Address)
        : null,
    listingExpiry: BigInt(r.listing_expiry ?? "0"),
  }
}

// Detail-only V2 columns: only meaningful on the by-id lookup, since a
// deferred/unwound row is never returned by the `status = 'active'`
// token readers above.
type V2DetailCols = {
  deferred_at_time?: string | null
  refund_amount?: string | null
  claim_recipient?: string | null
}
function v2DetailColFields(r: V2DetailCols): {
  deferredAtTime: number | null
  refundAmount: bigint | null
  claimRecipient: Address | null
} {
  return {
    deferredAtTime: r.deferred_at_time ? Number(r.deferred_at_time) : null,
    refundAmount: r.refund_amount ? BigInt(r.refund_amount) : null,
    claimRecipient:
      r.claim_recipient && r.claim_recipient !== ZERO_ADDRESS
        ? (r.claim_recipient as Address)
        : null,
  }
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
  const v2Cols = await hasV2AuctionColumns()
  const rows = (await sql.unsafe(
    `SELECT id, lower(house) AS house, auction_id::text AS auction_id,
            lower(seller) AS seller, lower(bidder) AS bidder,
            amount::text AS amount, reserve_price::text AS reserve,
            duration::text AS duration, end_time::text AS end_time,
            first_bid_time::text AS first_bid_time, status
            ${v2Cols ? `, version, standard, quantity::text AS quantity,
            funds_recipient, listing_expiry::text AS listing_expiry` : ""}
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
  } & V2Cols>
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
    ...v2ColFields(r),
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
  if (rows.length === 0) return readFndSeedAuctionForToken(contract, tokenId)
  const r = rows[0]
  const awaitingFirstBid = !r.bidder
  const amount = awaitingFirstBid ? BigInt(r.reserve) : BigInt(r.amount)
  const endTime = BigInt(r.end_time)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement = !awaitingFirstBid && endTime !== 0n && endTime <= now
  const bidder = (r.bidder ?? ZERO_ADDRESS) as Address

  const displays = await resolveDisplayNames([r.seller, bidder])
  const bidHistory = await readFndBidHistory(r.auction_id, displays)

  const fees = await readFndFees(contract, tokenId, amount).catch(() => null)

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
    houseVersion: 1 as const,
    tokenStandard: "erc721" as const,
    quantity: 1n,
    fundsRecipient: null,
    listingExpiry: 0n,
  }
}

/**
 * Fallback for FND auctions older than the indexer window. Ponder watches
 * NFTMarket from FND_START_BLOCK (~Oct 2025), but ~174k still-open FND
 * reserve auctions predate it — `fnd_auctions` has no row for them, which
 * is why token pages showed nothing for work that's visibly listed on
 * Foundation. The full-history seed (`public.fnd_cancellable_listings`,
 * migration 022) knows their auctionIds; one getReserveAuction read
 * returns the live struct, and the chain is ground truth — cancelled or
 * finalized auctions come back zero-filled and render nothing.
 *
 * The caller (`getAuctionForToken`) wraps this in a 30s pgCache, so the
 * cost is at most one eth_call per viewed token per 30s. Bid history
 * stays empty: pre-window bids aren't indexed, and a bid starts FND's
 * 24h end clock so bid-bearing auctions finalize out of this set fast.
 */
async function readFndSeedAuctionForToken(
  contract: string, tokenId: string,
): Promise<AuctionState | null> {
  if (!sql) return null
  const seed = (await sql.unsafe(
    `SELECT auction_id FROM fnd_cancellable_listings
     WHERE kind = 'auction' AND contract = $1 AND token_id = $2
     LIMIT 1`,
    [contract, tokenId],
  )) as Array<{ auction_id: string | null }>
  const auctionId = seed[0]?.auction_id
  if (!auctionId) return null

  const a = await getClient("token-auction-fnd-seed").readContract({
    address: FND_MARKET,
    abi: nftMarketAbi,
    functionName: "getReserveAuction",
    args: [BigInt(auctionId)],
  }) as {
    nftContract: Address; tokenId: bigint; seller: Address;
    duration: bigint; extensionDuration: bigint; endTime: bigint;
    bidder: Address; amount: bigint
  }
  const seller = a.seller.toLowerCase()
  if (seller === ZERO_ADDRESS) return null

  const bidderLower = a.bidder.toLowerCase()
  const awaitingFirstBid = bidderLower === ZERO_ADDRESS
  const bidder = bidderLower as Address
  // FND's struct `amount` is the reserve until the first bid, then the
  // current high bid — same meaning AuctionState expects either way.
  const amount = a.amount
  const now = BigInt(Math.floor(Date.now() / 1000))
  const awaitingSettlement =
    !awaitingFirstBid && a.endTime !== 0n && a.endTime <= now

  const displays = await resolveDisplayNames([seller, bidderLower])
  const fees = await readFndFees(contract, tokenId, amount).catch(() => null)

  return {
    source: "foundation",
    marketAddress: FND_MARKET,
    auctionId,
    nftContract: contract as Address,
    tokenId,
    seller: seller as Address,
    sellerDisplay: displays.get(seller) ?? seller,
    amount,
    bidder,
    bidderDisplay:
      bidderLower === ZERO_ADDRESS ? "" : (displays.get(bidderLower) ?? bidderLower),
    endTime: a.endTime,
    duration: a.duration,
    minBidWei: awaitingFirstBid ? amount : (amount * 105n) / 100n,
    awaitingFirstBid,
    awaitingSettlement,
    fees,
    bidHistory: [],
    houseVersion: 1 as const,
    tokenStandard: "erc721" as const,
    quantity: 1n,
    fundsRecipient: null,
    listingExpiry: 0n,
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

// ─── AuctionDetail: status-agnostic by-id lookup (per-auction page) ──────

// V2-only statuses beyond the v1 set (active/settled/cancelled):
// "deferred", delivery to the winner failed at settlement; nobody is
//   paid yet, and the lot is retryable via claimLot.
// "unwound", unwindStuckLot unwound the sale (winner refunded, lot back
//   with the seller); terminal.
// "unwound_return_pending", unwound, but the lot's return to the seller
//   also failed; awaiting returnUnwoundLot.
export type AuctionDetailStatus =
  | "active"
  | "settled"
  | "cancelled"
  | "deferred"
  | "unwound"
  | "unwound_return_pending"

/**
 * Full state of ONE auction, looked up by its on-chain identity (house +
 * auctionId for PND; the global auctionId for Foundation) with NO status
 * filter — so it resolves settled and cancelled auctions, not just the live
 * one (unlike `getSovereignAuctionByHouse`/`getFoundationAuction`, which route
 * through the `status='active'` token reader). Powers the per-auction page
 * `/auction/[house]/[auctionId]` and is the link target for Provenance "Sold"
 * entries.
 *
 * `live` is a ready-to-render `AuctionState` (for `AuctionPanel`) only while
 * the auction is active; settled/cancelled auctions render from the summary
 * fields (`winner`, `finalPriceWei`, `bids`, …).
 */
export type AuctionDetail = {
  source: "sovereign" | "foundation"
  marketAddress: Address
  auctionId: string
  nftContract: Address
  tokenId: string
  seller: Address
  sellerDisplay: string
  winner: Address | null
  winnerDisplay: string
  finalPriceWei: bigint | null
  settledAtTime: number | null
  settlementTxHash: string | null
  status: AuctionDetailStatus
  bids: BidHistoryEntry[]
  live: AuctionState | null
  houseVersion: 1 | 2
  tokenStandard: "erc721" | "erc1155"
  quantity: bigint
  fundsRecipient: Address | null
  listingExpiry: bigint
  // V2 only: when this row is "deferred", the block time DeliveryDeferred
  // fired.
  deferredAtTime: number | null
  // V2 only: when this row is "unwound" or "unwound_return_pending", the
  // winner's bid amount credited to pendingRefunds.
  refundAmount: bigint | null
  // V2 only: set once claimLot/unwindStuckLot's retry delivers a
  // previously deferred lot; the address delivery actually reached.
  claimRecipient: Address | null
}

function mapPndStatus(s: string): AuctionDetailStatus {
  return s === "settled" ||
    s === "cancelled" ||
    s === "deferred" ||
    s === "unwound" ||
    s === "unwound_return_pending"
    ? s
    : "active"
}
function mapFndStatus(s: string): AuctionDetailStatus {
  return s === "finalized"
    ? "settled"
    : s === "canceled" || s === "invalidated"
      ? "cancelled"
      : "active"
}

/**
 * Resolve one auction by its route identity. `house === FND_MARKET` selects
 * the Foundation lookup; any other address is treated as a PND sovereign
 * house. Returns null when no such auction exists.
 *
 * Not pgCached: `AuctionDetail` carries bigints, and pg-cache requires callers
 * to string-serialize bigints first (raw wei exceeds 2^53 and loses precision
 * as a JSON number). The per-auction page is low-traffic and already gets
 * Next.js route-segment caching + request-scoped `cache()`, so a couple of
 * indexed point-lookups per render is the right cost.
 */
export async function getAuctionDetail(
  house: string,
  auctionId: string,
): Promise<AuctionDetail | null> {
  if (!sql) return null
  return house.toLowerCase() === FND_MARKET.toLowerCase()
    ? getFndAuctionDetailById(auctionId)
    : getPndAuctionDetailById(house, auctionId)
}

async function getPndAuctionDetailById(
  house: string,
  auctionId: string,
): Promise<AuctionDetail | null> {
  if (!sql) return null
  const v2Cols = await hasV2AuctionColumns()
  const rows = (await sql.unsafe(
    `SELECT id, lower(house) AS house, auction_id::text AS auction_id,
            lower(token_contract) AS contract, token_id::text AS token_id,
            lower(seller) AS seller, lower(winner) AS winner,
            amount::text AS amount,
            seller_proceeds::text AS seller_proceeds,
            protocol_fee::text AS protocol_fee,
            settled_at_time::text AS settled_at_time,
            lifecycle_tx_hash, status
            ${v2Cols ? `, version, standard, quantity::text AS quantity,
            funds_recipient, listing_expiry::text AS listing_expiry,
            deferred_at_time::text AS deferred_at_time,
            refund_amount::text AS refund_amount, claim_recipient` : ""}
     FROM ${schema}.pnd_auctions
     WHERE lower(house) = $1 AND auction_id::text = $2 LIMIT 1`,
    [house.toLowerCase(), auctionId],
  )) as Array<{
    id: string; house: string; auction_id: string; contract: string;
    token_id: string; seller: string; winner: string | null;
    amount: string; seller_proceeds: string | null; protocol_fee: string | null;
    settled_at_time: string | null; lifecycle_tx_hash: string | null; status: string
  } & V2Cols & V2DetailCols>
  if (rows.length === 0) return null
  const r = rows[0]
  const status = mapPndStatus(r.status)
  const winner =
    r.winner && r.winner !== ZERO_ADDRESS ? (r.winner as Address) : null

  const displays = await resolveDisplayNames(
    [r.seller, winner ?? ""].filter(Boolean) as string[],
  )
  // Active auctions render via `live` (which carries its own bid history);
  // only fetch the standalone history for settled/cancelled auctions.
  const bids = status === "active" ? [] : await readPndBidHistory(r.id, displays)

  const finalPriceWei =
    status === "settled"
      ? BigInt(r.seller_proceeds ?? "0") + BigInt(r.protocol_fee ?? "0")
      : null

  const live =
    status === "active"
      ? await readPndAuctionForToken(r.contract, r.token_id)
      : null

  return {
    source: "sovereign",
    marketAddress: r.house as Address,
    auctionId: r.auction_id,
    nftContract: r.contract as Address,
    tokenId: r.token_id,
    seller: r.seller as Address,
    sellerDisplay: displays.get(r.seller) ?? r.seller,
    winner,
    winnerDisplay: winner ? (displays.get(winner) ?? winner) : "",
    finalPriceWei,
    settledAtTime: r.settled_at_time ? Number(r.settled_at_time) : null,
    settlementTxHash: r.lifecycle_tx_hash,
    status,
    bids,
    live,
    ...v2ColFields(r),
    ...v2DetailColFields(r),
  }
}

async function getFndAuctionDetailById(
  auctionId: string,
): Promise<AuctionDetail | null> {
  if (!sql) return null
  const rows = (await sql.unsafe(
    `SELECT auction_id::text AS auction_id, lower(nft_contract) AS contract,
            token_id::text AS token_id, lower(seller) AS seller,
            lower(highest_bidder) AS bidder, highest_bid::text AS amount,
            finalized_total_fees::text AS f_fees,
            finalized_creator_rev::text AS f_creator,
            finalized_seller_rev::text AS f_seller,
            finalized_at_time::text AS finalized_at_time,
            finalized_tx_hash, status
     FROM ${schema}.fnd_auctions
     WHERE auction_id::text = $1 LIMIT 1`,
    [auctionId],
  )) as Array<{
    auction_id: string; contract: string; token_id: string; seller: string;
    bidder: string | null; amount: string;
    f_fees: string | null; f_creator: string | null; f_seller: string | null;
    finalized_at_time: string | null; finalized_tx_hash: string | null; status: string
  }>
  if (rows.length === 0) return null
  const r = rows[0]
  const status = mapFndStatus(r.status)
  const winner =
    r.bidder && r.bidder !== ZERO_ADDRESS ? (r.bidder as Address) : null

  const displays = await resolveDisplayNames(
    [r.seller, winner ?? ""].filter(Boolean) as string[],
  )
  const bids = status === "active" ? [] : await readFndBidHistory(r.auction_id, displays)

  const finalPriceWei =
    status === "settled"
      ? BigInt(r.f_fees ?? "0") + BigInt(r.f_creator ?? "0") + BigInt(r.f_seller ?? "0")
      : null

  const live =
    status === "active"
      ? await readFndAuctionForToken(r.contract, r.token_id)
      : null

  return {
    source: "foundation",
    marketAddress: FND_MARKET,
    auctionId: r.auction_id,
    nftContract: r.contract as Address,
    tokenId: r.token_id,
    seller: r.seller as Address,
    sellerDisplay: displays.get(r.seller) ?? r.seller,
    winner,
    winnerDisplay: winner ? (displays.get(winner) ?? winner) : "",
    finalPriceWei,
    settledAtTime: r.finalized_at_time ? Number(r.finalized_at_time) : null,
    settlementTxHash: r.finalized_tx_hash,
    status,
    bids,
    live,
    houseVersion: 1 as const,
    tokenStandard: "erc721" as const,
    quantity: 1n,
    fundsRecipient: null,
    listingExpiry: 0n,
    deferredAtTime: null,
    refundAmount: null,
    claimRecipient: null,
  }
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

// ─── getArtistFndAuctionMap ──────────────────────────────────────────────

/**
 * Active Foundation reserve auctions where this artist is the seller,
 * keyed `${contract}:${tokenId}` — the Foundation counterpart to
 * getArtistSovereignAuctionMap, so the gallery badges/sorts FND listings
 * the same way it does Sovereign ones. Two sources, same as the token
 * page (readFndSeedAuctionForToken): Ponder `fnd_auctions` for auctions
 * inside the indexer window, and the full-history seed
 * (`fnd_cancellable_listings`) for older ones, each confirmed live via
 * getReserveAuction (chain is ground truth; settled/cancelled drop out).
 */
export async function getArtistFndAuctionMap(
  artistAddress: string,
): Promise<Record<string, SovereignAuctionLite>> {
  if (!sql) return {}
  return getArtistFndAuctionMapCached(artistAddress.toLowerCase())
}

const getArtistFndAuctionMapCached = unstable_cache(
  async (lower: string): Promise<Record<string, SovereignAuctionLite>> => {
    return pgCache<Record<string, SovereignAuctionLite>>(
      `artist-fnd-auction-map:${lower}`,
      30,
      async () => {
        if (!sql) return {}
        const now = Math.floor(Date.now() / 1000)
        const map: Record<string, SovereignAuctionLite> = {}

        // 1. Indexer-window auctions (fresh, no chain read needed).
        const ponderRows = (await sql.unsafe(
          `SELECT auction_id::text AS auction_id,
                  lower(nft_contract) AS contract, token_id::text AS token_id,
                  reserve_price::text AS reserve, highest_bid::text AS bid,
                  lower(highest_bidder) AS bidder, end_time::text AS end_time
           FROM ${schema}.fnd_auctions
           WHERE lower(seller) = $1 AND status = 'active'`,
          [lower],
        )) as Array<{
          auction_id: string; contract: string; token_id: string;
          reserve: string; bid: string; bidder: string | null; end_time: string
        }>
        for (const r of ponderRows) {
          map[`${r.contract}:${r.token_id}`] = toFndAuctionLite({
            auctionId: r.auction_id,
            reserveWei: r.reserve,
            highestBidWei: r.bid,
            hasBidder: !!r.bidder && r.bidder !== ZERO_ADDRESS,
            endTime: Number(r.end_time),
            nowSec: now,
          })
        }

        // 2. Older auctions from the full-history seed, confirmed on-chain.
        const seedRows = (await sql.unsafe(
          `SELECT auction_id, lower(contract) AS contract, token_id,
                  price_wei AS reserve
           FROM public.fnd_cancellable_listings
           WHERE kind = 'auction' AND lower(seller) = $1 AND auction_id IS NOT NULL`,
          [lower],
        )) as Array<{
          auction_id: string; contract: string; token_id: string; reserve: string
        }>
        const need = seedRows.filter(
          (r) => !map[`${r.contract}:${r.token_id}`],
        )
        if (need.length > 0) {
          const results = await getClient("artist-fnd-auction-map").multicall({
            allowFailure: true,
            contracts: need.map((r) => ({
              address: FND_MARKET,
              abi: nftMarketAbi,
              functionName: "getReserveAuction" as const,
              args: [BigInt(r.auction_id)] as const,
            })),
          })
          results.forEach((res, i) => {
            if (res.status !== "success") return
            const a = res.result as {
              seller: Address; endTime: bigint; bidder: Address; amount: bigint
            }
            if (a.seller.toLowerCase() === ZERO_ADDRESS) return
            const r = need[i]
            map[`${r.contract}:${r.token_id}`] = toFndAuctionLite({
              auctionId: r.auction_id,
              reserveWei: r.reserve,
              highestBidWei: a.amount.toString(),
              hasBidder: a.bidder.toLowerCase() !== ZERO_ADDRESS,
              endTime: Number(a.endTime),
              nowSec: now,
            })
          })
        }

        return map
      },
    )
  },
  ["artist-fnd-auction-map-v1"],
  { revalidate: 30, tags: ["artist-fnd-auction-map"] },
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

async function readFndFees(
  nftContract: string,
  tokenId: string,
  price: bigint,
): Promise<AuctionFees | null> {
  // Live per-token split from the market itself. Foundation has changed
  // its protocol fee over time — settle events show 15% historically,
  // 5% through ~block 24.96M, and 0% since ~block 25.1M (2026-05) — so
  // the static "published schedule" hint this used to return both
  // overstated the platform's take and made primary listings read like
  // resales. getFeesAndRecipients is the same math the settle call pays
  // out, including per-token royalty overrides and split recipients.
  // Callers sit inside getAuctionForToken's 30s pgCache, so this costs
  // one eth_call per viewed FND token per 30s; on failure callers catch
  // to null and the fee box simply doesn't render — honest over wrong.
  if (price <= 0n) return null
  const [totalFees, creatorRev, , , sellerRev] = (await getClient(
    "fnd-fees",
  ).readContract({
    address: FND_MARKET,
    abi: nftMarketAbi,
    functionName: "getFeesAndRecipients",
    args: [nftContract as Address, BigInt(tokenId), price],
  })) as readonly [bigint, bigint, readonly Address[], readonly bigint[], bigint, Address]
  const bps = (x: bigint) => Number((x * 10000n) / price)
  return {
    platformLabel: "Foundation",
    protocolFeeBps: bps(totalFees),
    creatorRoyaltyBps: bps(creatorRev),
    sellerBps: bps(sellerRev),
  }
}

// Re-exports for adapter consumers
export { FND_MARKET, SOVEREIGN_FACTORY, TL_AH, ZERO_ADDRESS }
