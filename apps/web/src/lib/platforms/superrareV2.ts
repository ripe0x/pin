import "server-only"
import type { Address } from "viem"
import type {
  PlatformAdapter, ArtistTokenRef, CollectorTokenRef, AdapterLastSale,
  ActiveAuctionSummary, SellerListingsResult,
} from "./types"
import { sql } from "../db"
import { getSrv2TokensFromIndexer } from "../indexer-queries"
import { getActiveSrV2AuctionMap } from "../onchain"

const schema = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g, "",
)

// The worker runs every five minutes. Three intervals gives normal deploy and
// provider jitter room while refusing to call an old empty snapshot complete.
const LISTING_COVERAGE_FRESHNESS_MINUTES = 15

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

  /**
   * Cancellable SuperRare auctions from the worker's fixed-Bazaar index.
   * This is a Postgres-only read: the worker already verifies tokenAuctions
   * and auctionBids at a finalized block, so /delist never starts a historical
   * getLogs scan or a per-listing RPC fan-out.
   */
  async getCancellableListingsForSeller(
    seller: Address,
  ): Promise<SellerListingsResult | null> {
    if (!sql) return { auctions: [], buyNows: [], complete: false }
    const lower = seller.toLowerCase()
    const [rows, coverageRows] = await Promise.all([
      sql`
        SELECT contract, token_id, reserve_wei,
               duration_seconds::text AS duration_seconds
        FROM srv2_active_auctions
        WHERE seller = ${lower}
          AND status = 'active'
          AND current_bidder IS NULL
          AND current_bid_wei::numeric = 0
        ORDER BY last_observed_block DESC, contract, token_id
      `,
      sql`
        SELECT complete,
               last_success_at >= NOW() -
                 (${LISTING_COVERAGE_FRESHNESS_MINUTES}::text || ' minutes')::interval
                 AS fresh,
               EXISTS (
                 SELECT 1 FROM known_artists
                 WHERE lower(address) = ${lower}
               ) AS eligible
        FROM srv2_listing_coverage
        WHERE scope = 'global'
        LIMIT 1
      `,
    ])
    const coverage = coverageRows[0] as unknown as
      | { complete: boolean; fresh: boolean; eligible: boolean }
      | undefined

    return {
      auctions: (rows as unknown as Array<{
        contract: string
        token_id: string
        reserve_wei: string
        duration_seconds: string
      }>).map((row) => ({
        id: `srv2:auction:${row.contract.toLowerCase()}:${row.token_id}`,
        platform: "superrareV2" as const,
        auctionId: `${row.contract.toLowerCase()}:${row.token_id}`,
        nftContract: row.contract.toLowerCase(),
        tokenId: row.token_id,
        reserveWei: row.reserve_wei,
        durationSeconds: Number(row.duration_seconds),
      })),
      buyNows: [],
      // The worker deliberately scans only known artists. An arbitrary wallet
      // is therefore partial even when the shared Bazaar cursor is current.
      complete:
        coverage?.complete === true &&
        coverage.fresh === true &&
        coverage.eligible === true,
    }
  },
}
