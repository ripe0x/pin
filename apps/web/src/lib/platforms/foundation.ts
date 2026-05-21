import "server-only"
import type { Address } from "viem"
import type {
  PlatformAdapter, ArtistTokenRef, CollectorTokenRef,
  AdapterLastSale, SellerListings, ActiveAuctionSummary,
} from "./types"
import { sql } from "../db"
import { getFoundationTokensFromIndexer } from "../indexer-queries"
import { getLastSale as readLastSale } from "../reads"

const FND_NFT_MARKET = "0xcDA72070E455bb31C7690a170224Ce43623d0B6f"

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
    if (!sql) return null
    const lower = seller.toLowerCase()
    const [auctions, buyNows] = await Promise.all([
      sql.unsafe(
        `SELECT auction_id::text AS auction_id, nft_contract, token_id::text,
                reserve_price::text AS reserve_wei,
                duration_seconds::text AS duration
         FROM ${schema}.fnd_auctions
         WHERE lower(seller) = $1 AND status = 'active' AND highest_bidder IS NULL`,
        [lower],
      ) as Promise<Array<{
        auction_id: string; nft_contract: string; token_id: string;
        reserve_wei: string; duration: string
      }>>,
      sql.unsafe(
        `SELECT id, nft_contract, token_id::text, price::text AS price_wei
         FROM ${schema}.fnd_buy_nows
         WHERE lower(seller) = $1 AND status = 'active'`,
        [lower],
      ) as Promise<Array<{
        id: string; nft_contract: string; token_id: string; price_wei: string
      }>>,
    ])
    return {
      auctions: auctions.map((r) => ({
        id: r.auction_id,
        platform: "foundation",
        auctionId: r.auction_id,
        nftContract: r.nft_contract,
        tokenId: r.token_id,
        reserveWei: r.reserve_wei,
        durationSeconds: Number(r.duration),
      })),
      buyNows: buyNows.map((r) => ({
        id: r.id,
        platform: "foundation",
        nftContract: r.nft_contract,
        tokenId: r.token_id,
        priceWei: r.price_wei,
      })),
    }
  },
}
