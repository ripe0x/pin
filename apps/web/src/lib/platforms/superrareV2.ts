import "server-only"
import type { Address } from "viem"
import type {
  PlatformAdapter, ArtistTokenRef, CollectorTokenRef, AdapterLastSale,
  ActiveAuctionSummary,
} from "./types"
import { sql } from "../db"
import { getSrv2TokensFromIndexer } from "../indexer-queries"
import { getActiveSrV2AuctionMap } from "../onchain"

const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export const superrareV2Adapter: PlatformAdapter & {
  getActiveAuctionMap: (artist: Address) => Promise<Record<string, { reserveWei: bigint; currentBidWei: bigint }>>
} = {
  id: "superrareV2",
  displayName: "SuperRare",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    const rows = (await getSrv2TokensFromIndexer(artist.toLowerCase())) ?? []
    return rows.map((r) => ({
      platform: "superrareV2" as const,
      contract: r.contract as Address,
      tokenId: r.tokenId,
      blockNumber: r.blockNumber,
      logIndex: r.logIndex,
      collectionName: null,
    }))
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
           SELECT 1 FROM ${schema}.srv2_artist_tokens
             WHERE lower(contract) = o.contract AND token_id::text = o.token_id
         )
       ORDER BY o.transferred_at_block DESC LIMIT 200`,
      [lower],
    )) as Array<{
      contract: string; token_id: string; block: string; tx_hash: string | null
    }>
    return rows.map((r) => ({
      platform: "superrareV2",
      contract: r.contract as Address,
      tokenId: r.token_id,
      ownerWallet: lower as Address,
      acquiredAtBlock: BigInt(r.block),
      acquiredTxHash: r.tx_hash,
    }))
  },

  async getLastSale(): Promise<AdapterLastSale | null> {
    // v2 doesn't index SR Bazaar marketplace events (see PLAN.md).
    // Last-sale for SR tokens isn't surfaceable until/unless someone
    // extends the worker with an SR sale scanner. Return null; the UI
    // handles "no last sale" gracefully.
    return null
  },

  async getActiveAuctions(_limit: number): Promise<ActiveAuctionSummary[]> {
    return []
  },

  async getActiveAuctionMap(artist: Address) {
    return getActiveSrV2AuctionMap(artist)
  },
}
