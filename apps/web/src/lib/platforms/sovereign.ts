import "server-only"
import type { Address } from "viem"
import type {
  PlatformAdapter, ArtistTokenRef, AdapterLastSale, ActiveAuctionSummary,
} from "./types"
import { sql } from "../db"

const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export const sovereignAdapter: PlatformAdapter = {
  id: "sovereign",
  displayName: "Sovereign",

  async discoverArtistTokens(): Promise<ArtistTokenRef[]> {
    // PND houses don't have a per-house "minted by artist" stream —
    // the artist's gallery surfaces work indexed under FND/Mint/TL/SR
    // platforms; PND auctions decorate those rows in the UI.
    return []
  },

  async getLastSale(
    contract: Address, tokenId: string,
  ): Promise<AdapterLastSale | null> {
    if (!sql) return null
    const rows = (await sql.unsafe(
      `SELECT amount::text AS price_wei, settled_at_time::text AS block_time,
              lifecycle_tx_hash AS tx_hash
       FROM ${schema}.pnd_auctions
       WHERE lower(token_contract) = $1 AND token_id::text = $2
         AND status = 'settled'
       ORDER BY settled_at_time DESC LIMIT 1`,
      [contract.toLowerCase(), tokenId],
    )) as Array<{ price_wei: string; block_time: string; tx_hash: string | null }>
    if (rows.length === 0) return null
    return {
      platform: "sovereign",
      priceWei: BigInt(rows[0].price_wei),
      blockTime: Number(rows[0].block_time),
      source: "auction",
      txHash: rows[0].tx_hash ?? "",
    }
  },

  async getActiveAuctions(limit: number): Promise<ActiveAuctionSummary[]> {
    if (!sql) return []
    const rows = (await sql.unsafe(
      `SELECT lower(house) AS house, lower(token_contract) AS contract,
              token_id::text AS token_id, lower(seller) AS seller,
              reserve_price::text AS reserve_wei,
              amount::text AS current_bid_wei,
              lower(bidder) AS bidder,
              end_time::text AS end_time
       FROM ${schema}.pnd_auctions
       WHERE status = 'active'
       ORDER BY CASE WHEN end_time = 0 THEN 1 ELSE 0 END, end_time ASC
       LIMIT $1`,
      [limit],
    )) as Array<{
      house: string; contract: string; token_id: string; seller: string;
      reserve_wei: string; current_bid_wei: string; bidder: string | null;
      end_time: string
    }>
    return rows.map((r) => ({
      platform: "sovereign",
      contract: r.contract as Address,
      tokenId: r.token_id,
      seller: r.seller as Address,
      reserveWei: BigInt(r.reserve_wei),
      currentBidWei: BigInt(r.current_bid_wei),
      currentBidder: r.bidder
        ? (r.bidder.toLowerCase() === "0x0000000000000000000000000000000000000000"
            ? null : (r.bidder as Address))
        : null,
      endTime: Number(r.end_time),
      sourceContract: r.house as Address,
    }))
  },
}
