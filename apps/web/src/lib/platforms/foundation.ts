import "server-only"
import { createPublicClient, http, parseAbi, type Address } from "viem"
import { mainnet } from "viem/chains"
import type {
  PlatformAdapter, ArtistTokenRef, CollectorTokenRef,
  AdapterLastSale, SellerListings, ActiveAuctionSummary,
} from "./types"
import { sql } from "../db"
import { getFoundationTokensFromIndexer } from "../indexer-queries"
import { getLastSale as readLastSale } from "../reads"
import fndCancellable from "../../data/fnd-cancellable.json"

const FND_NFT_MARKET = "0xcDA72070E455bb31C7690a170224Ce43623d0B6f"

// Static seed of every FND seller's cancellable listings as of the
// last switchback dump (auctions) + on-chain BuyPriceSet scan
// (buy-nows). Foundation stopped accepting new listings in late 2025,
// so this set only shrinks via cancellations.
//
// The static file is the discovery side ("who *could* still have
// something cancellable"); the on-chain multicall below is the
// verification side ("what they actually have right now"). Together
// they give correct results without an indexer subscription or worker
// scan.
type StaticEntry = {
  auctions: Array<{
    contract: string; tokenId: string; auctionId: string; reserveWei: string
  }>
  buyNows: Array<{
    contract: string; tokenId: string; priceWei: string
  }>
}
const fndSeed = fndCancellable as Record<string, StaticEntry>

const ZERO_ADDR = "0x0000000000000000000000000000000000000000"

const nftMarketReadAbi = parseAbi([
  "function getReserveAuction(uint256 auctionId) view returns ((address nftContract, uint256 tokenId, address seller, uint256 duration, uint256 extensionDuration, uint256 endTime, address bidder, uint256 amount))",
  "function getBuyPrice(address nftContract, uint256 tokenId) view returns ((address seller, uint256 price))",
])

function getReadClient() {
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return createPublicClient({ chain: mainnet, transport: http(explicit) })
  const key = process.env.ALCHEMY_API_KEY
  const url = key && !key.startsWith("set-")
    ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
    : "https://eth.drpc.org"
  return createPublicClient({ chain: mainnet, transport: http(url) })
}

const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export const foundationAdapter: PlatformAdapter = {
  id: "foundation",
  displayName: "Foundation",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    if (!sql) return []
    const lower = artist.toLowerCase()
    const shared = (await getFoundationTokensFromIndexer(lower)) ?? []
    const perArtist = (await sql.unsafe(
      `SELECT lower(contract) AS contract, token_id, mint_block::text AS mint_block, mint_log_index
       FROM artist_tokens
       WHERE artist = $1 AND platform = 'fnd-collection'
       ORDER BY mint_block DESC, mint_log_index DESC`,
      [lower],
    )) as Array<{
      contract: string; token_id: string; mint_block: string; mint_log_index: number
    }>
    return [
      ...shared.map((r) => ({
        platform: "foundation" as const,
        contract: r.contract as Address,
        tokenId: r.tokenId,
        blockNumber: r.blockNumber,
        logIndex: r.logIndex,
        collectionName: null,
      })),
      ...perArtist.map((r) => ({
        platform: "foundation" as const,
        contract: r.contract as Address,
        tokenId: r.token_id,
        blockNumber: BigInt(r.mint_block),
        logIndex: r.mint_log_index,
        collectionName: null,
      })),
    ]
  },

  async discoverCollectorTokens(wallet: Address): Promise<CollectorTokenRef[]> {
    if (!sql) return []
    const lower = wallet.toLowerCase()
    const rows = (await sql.unsafe(
      `SELECT o.contract, o.token_id, o.transferred_at_block::text AS block,
              o.tx_hash
       FROM token_owners o
       WHERE o.owner = $1
         AND EXISTS (
           SELECT 1 FROM ${schema}.fnd_artist_tokens
             WHERE lower(contract) = o.contract AND token_id::text = o.token_id
           UNION
           SELECT 1 FROM artist_tokens
             WHERE lower(contract) = o.contract AND token_id = o.token_id
               AND platform IN ('fnd-shared', 'fnd-collection')
         )
       ORDER BY o.transferred_at_block DESC LIMIT 200`,
      [lower],
    )) as Array<{
      contract: string; token_id: string; block: string; tx_hash: string | null
    }>
    return rows.map((r) => ({
      platform: "foundation",
      contract: r.contract as Address,
      tokenId: r.token_id,
      ownerWallet: lower as Address,
      acquiredAtBlock: BigInt(r.block),
      acquiredTxHash: r.tx_hash,
    }))
  },

  async getLastSale(contract: Address, tokenId: string): Promise<AdapterLastSale | null> {
    const sale = await readLastSale(contract, tokenId)
    if (!sale) return null
    return {
      platform: "foundation",
      priceWei: sale.priceWei,
      blockTime: Number(sale.blockTime),
      source: sale.source,
      txHash: sale.txHash,
    }
  },

  async getActiveAuctions(limit: number): Promise<ActiveAuctionSummary[]> {
    if (!sql) return []
    const rows = (await sql.unsafe(
      `SELECT a.nft_contract, a.token_id::text AS token_id, a.seller,
              a.reserve_price::text AS reserve_wei,
              a.highest_bid::text AS current_bid_wei,
              a.highest_bidder, a.end_time::text AS end_time
       FROM ${schema}.fnd_auctions a
       WHERE a.status = 'active'
       ORDER BY CASE WHEN a.end_time = 0 THEN 1 ELSE 0 END, a.end_time ASC
       LIMIT $1`,
      [limit],
    )) as Array<{
      nft_contract: string; token_id: string; seller: string;
      reserve_wei: string; current_bid_wei: string;
      highest_bidder: string | null; end_time: string
    }>
    return rows.map((r) => ({
      platform: "foundation",
      contract: r.nft_contract as Address,
      tokenId: r.token_id,
      seller: r.seller as Address,
      reserveWei: BigInt(r.reserve_wei),
      currentBidWei: BigInt(r.current_bid_wei),
      currentBidder: (r.highest_bidder ?? null) as Address | null,
      endTime: Number(r.end_time),
      sourceContract: FND_NFT_MARKET as Address,
    }))
  },

  async getCancellableListingsForSeller(seller: Address): Promise<SellerListings | null> {
    const lower = seller.toLowerCase()
    const seed = fndSeed[lower]
    if (!seed || (seed.auctions.length === 0 && seed.buyNows.length === 0)) {
      return { auctions: [], buyNows: [] }
    }

    // On-chain verification: the static seed is frozen at dump time, so
    // any row could be cancelled / finalized since. One multicall checks
    // every candidate's current state against NFTMarket. Cancelled and
    // finalized auctions return a zero-filled struct (FND deletes the
    // storage slot on those events); buy-nows return a zero seller.
    const client = getReadClient()
    const calls = [
      ...seed.auctions.map((a) => ({
        address: FND_NFT_MARKET as Address,
        abi: nftMarketReadAbi,
        functionName: "getReserveAuction" as const,
        args: [BigInt(a.auctionId)] as const,
      })),
      ...seed.buyNows.map((b) => ({
        address: FND_NFT_MARKET as Address,
        abi: nftMarketReadAbi,
        functionName: "getBuyPrice" as const,
        args: [b.contract as Address, BigInt(b.tokenId)] as const,
      })),
    ]
    const results = await client.multicall({ contracts: calls, allowFailure: true })

    const auctions: SellerListings["auctions"] = []
    for (let i = 0; i < seed.auctions.length; i++) {
      const r = results[i]
      if (r.status !== "success") continue
      const a = r.result as {
        nftContract: Address; tokenId: bigint; seller: Address;
        duration: bigint; bidder: Address; amount: bigint
      }
      // Still cancellable if (a) seller still matches AND (b) no bid placed.
      // Foundation's cancelReserveAuction reverts once a bid lands.
      if (a.seller.toLowerCase() !== lower) continue
      if (a.bidder.toLowerCase() !== ZERO_ADDR) continue
      auctions.push({
        id: seed.auctions[i].auctionId,
        platform: "foundation",
        auctionId: seed.auctions[i].auctionId,
        nftContract: seed.auctions[i].contract,
        tokenId: seed.auctions[i].tokenId,
        reserveWei: a.amount.toString(),
        durationSeconds: Number(a.duration),
      })
    }

    const buyNows: SellerListings["buyNows"] = []
    for (let i = 0; i < seed.buyNows.length; i++) {
      const r = results[seed.auctions.length + i]
      if (r.status !== "success") continue
      const b = r.result as { seller: Address; price: bigint }
      if (b.seller.toLowerCase() !== lower) continue
      buyNows.push({
        id: `${seed.buyNows[i].contract}-${seed.buyNows[i].tokenId}`,
        platform: "foundation",
        nftContract: seed.buyNows[i].contract,
        tokenId: seed.buyNows[i].tokenId,
        priceWei: b.price.toString(),
      })
    }

    return { auctions, buyNows }
  },
}
