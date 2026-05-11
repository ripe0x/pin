import "server-only"
import { createPublicClient, type Address } from "viem"
import { mainnet } from "viem/chains"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  CollectorTokenRef,
  AdapterLastSale,
  ActiveAuctionSummary,
} from "./types"
import {
  getSettledAuctionForToken,
  getActivePndAuctions,
} from "../indexer-queries"
import { getSovereignLastSale } from "../last-sale"
import { sql } from "../db"
import { getMainnetTransport } from "../alchemy-rpc"

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: getMainnetTransport("sovereign"),
  })
}

/**
 * Sovereign (PND) platform adapter. Sovereign Auction Houses don't mint
 * tokens — they auction tokens that exist on other contracts (Foundation
 * shared NFT, Foundation collections, Manifold creator cores, ERC-721/
 * 1155 contracts in general). So `discoverArtistTokens` returns [] and
 * the artist gallery is unaffected.
 *
 * The interesting Sovereign methods are marketplace ones:
 *   - getLastSale: served by Ponder via `pnd_auctions.status='settled'`
 *   - getActiveAuctionForToken: TODO (currently in auctions.ts directly)
 *   - getBidHistory: TODO (currently in auctions.ts directly)
 */
export const sovereignAdapter: PlatformAdapter = {
  id: "sovereign",
  displayName: "Sovereign Auction House",

  async discoverArtistTokens(): Promise<ArtistTokenRef[]> {
    // Sovereign auction houses don't mint; the tokens they escrow live
    // on other platforms' contracts and surface there.
    return []
  },

  async discoverCollectorTokens(
    wallet: Address,
  ): Promise<CollectorTokenRef[]> {
    if (!sql) return []
    try {
      const schema = (process.env.INDEXER_SCHEMA ?? "ponder").replace(
        /[^a-zA-Z0-9_]/g,
        "",
      )
      // Tokens this wallet won via a settled Sovereign auction. The
      // token contract + tokenId come straight off the indexed auction
      // row; current ownership isn't tracked by Ponder (the token
      // transferred out of the house to the winner on settle), so this
      // is a best-effort historical record. Reads as `acquiredAtBlock`
      // = settledAtBlock.
      const rows = (await sql.unsafe(
        `SELECT token_contract, token_id::text AS token_id,
                settled_at_block::text AS settled_at_block
         FROM ${schema}.pnd_auctions
         WHERE winner = $1 AND status = 'settled'
         ORDER BY settled_at_time DESC`,
        [wallet.toLowerCase()],
      )) as Array<{
        token_contract: string
        token_id: string
        settled_at_block: string
      }>

      return rows.map((r) => ({
        platform: "sovereign",
        contract: r.token_contract as Address,
        tokenId: r.token_id,
        ownerWallet: wallet,
        acquiredAtBlock: BigInt(r.settled_at_block),
        acquiredTxHash: null,
      }))
    } catch {
      return []
    }
  },

  async getLastSale(
    contract: Address,
    tokenId: string,
    creator: Address | null,
  ): Promise<AdapterLastSale | null> {
    // Indexer first — when Ponder is up, this is a Postgres point query.
    const settled = await getSettledAuctionForToken(contract, tokenId)
    if (settled) {
      return {
        platform: "sovereign",
        priceWei: settled.amount,
        blockTime: settled.settledAtTime,
        source: "auction",
        txHash: "",
      }
    }
    // RPC fallback for when the indexer is down / lagging. Requires
    // creator to look up the artist's house address via houseOf(creator).
    if (!creator) return null
    const client = getClient()
    const sale = await getSovereignLastSale(
      client,
      contract,
      BigInt(tokenId),
      creator,
    )
    if (!sale) return null
    return {
      platform: "sovereign",
      priceWei: sale.priceWei,
      blockTime: sale.blockTime,
      source: sale.source, // "sovereign"
      txHash: sale.txHash,
    }
  },

  async getActiveAuctions(limit: number): Promise<ActiveAuctionSummary[]> {
    const rows = await getActivePndAuctions(limit)
    if (!rows) return []
    return rows.map((r) => ({
      platform: "sovereign",
      contract: r.tokenContract as Address,
      tokenId: r.tokenId,
      seller: r.seller as Address,
      reserveWei: r.reservePrice,
      currentBidWei: r.amount,
      currentBidder: null,
      endTime: r.endTime,
      // The "marketplace" address for a PND auction is its house —
      // bids dispatch there. Each row already carries its house.
      sourceContract: r.house as Address,
    }))
  },
}
