import "server-only"
import type { Address } from "viem"
import type {
  PlatformAdapter, ArtistTokenRef, CollectorTokenRef, AdapterLastSale,
} from "./types"
import { sql } from "../db"

const schema = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export const mintAdapter: PlatformAdapter = {
  id: "mint",
  displayName: "Mint",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    if (!sql) return []
    const lower = artist.toLowerCase()
    const rows = (await sql.unsafe(
      `SELECT lower(contract) AS contract, token_id,
              mint_block::text AS mint_block, mint_log_index
       FROM artist_tokens
       WHERE artist = $1 AND platform = 'mint'
       ORDER BY mint_block DESC, mint_log_index DESC`,
      [lower],
    )) as Array<{
      contract: string; token_id: string; mint_block: string; mint_log_index: number
    }>
    return rows.map((r) => ({
      platform: "mint" as const,
      contract: r.contract as Address,
      tokenId: r.token_id,
      blockNumber: BigInt(r.mint_block),
      logIndex: r.mint_log_index,
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
           SELECT 1 FROM ${schema}.mint_creators
             WHERE lower(contract) = o.contract
         )
       ORDER BY o.transferred_at_block DESC LIMIT 200`,
      [lower],
    )) as Array<{
      contract: string; token_id: string; block: string; tx_hash: string | null
    }>
    return rows.map((r) => ({
      platform: "mint",
      contract: r.contract as Address,
      tokenId: r.token_id,
      ownerWallet: lower as Address,
      acquiredAtBlock: BigInt(r.block),
      acquiredTxHash: r.tx_hash,
    }))
  },

  async getLastSale(): Promise<AdapterLastSale | null> {
    return null
  },
}
