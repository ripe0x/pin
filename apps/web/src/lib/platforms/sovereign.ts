import "server-only"
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  AdapterLastSale,
} from "./types"
import { getSettledAuctionForToken } from "../indexer-queries"
import { getSovereignLastSale } from "../last-sale"

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com",
    ),
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
}
