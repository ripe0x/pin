import "server-only"
import type { Address } from "viem"
import type {
  PlatformAdapter, ArtistTokenRef, CollectorTokenRef, AdapterLastSale,
} from "./types"
import { sql } from "../db"

export const manifoldAdapter: PlatformAdapter = {
  id: "manifold",
  displayName: "Manifold",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    if (!sql) return []
    const lower = artist.toLowerCase()
    const rows = (await sql.unsafe(
      `SELECT lower(contract) AS contract, token_id,
              mint_block::text AS mint_block, mint_log_index
       FROM artist_tokens
       WHERE artist = $1 AND platform = 'manifold'
       ORDER BY mint_block DESC, mint_log_index DESC`,
      [lower],
    )) as Array<{
      contract: string; token_id: string; mint_block: string; mint_log_index: number
    }>
    return rows.map((r) => ({
      platform: "manifold" as const,
      contract: r.contract as Address,
      tokenId: r.token_id,
      blockNumber: BigInt(r.mint_block),
      logIndex: r.mint_log_index,
      collectionName: null,
    }))
  },

  async discoverCollectorTokens(_wallet: Address): Promise<CollectorTokenRef[]> {
    // Manifold collector view: v1 used Alchemy NFT API on every render.
    // Not bringing that back; the v2 collector page surfaces what's in
    // token_owners (which covers indexed contracts only). Manifold
    // collector tokens are out of scope for day 1 of v2.
    return []
  },

  async getLastSale(): Promise<AdapterLastSale | null> {
    return null
  },
}
