import "server-only"
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  AdapterLastSale,
  SellerListings,
} from "./types"
import { discoverFoundationArtistRefs } from "../onchain-discovery"
import { getFoundationLastSale } from "../last-sale"

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
 * Foundation platform adapter. Wraps the existing Foundation discovery,
 * last-sale, bid history, and seller-listings code so the orchestrator
 * can call it via the platform registry without knowing about
 * Foundation-specific internals.
 *
 * Implementation: each method delegates to the existing Foundation
 * functions, which already do their own lazy read/write through the
 * `lazy_fnd_*` tables. This adapter is a thin protocol layer; behavior
 * is identical to the pre-adapter code.
 *
 * `getLastSale` / `getBidHistory` / `getCancellableListingsForSeller`
 * are wired in the next step (this PR) — for now they're stubbed to
 * return null so the orchestrators in `last-sale.ts` and `auctions.ts`
 * can call the registry without losing data, then we move the real
 * implementations into the adapter.
 */
export const foundationAdapter: PlatformAdapter = {
  id: "foundation",
  displayName: "Foundation",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    const refs = await discoverFoundationArtistRefs(artist)
    return refs.map((r) => ({
      platform: "foundation",
      contract: r.contract,
      tokenId: r.tokenId,
      blockNumber: r.blockNumber,
      logIndex: r.logIndex,
      collectionName: r.collectionName,
    }))
  },

  async getLastSale(
    contract: Address,
    tokenId: string,
  ): Promise<AdapterLastSale | null> {
    const client = getClient()
    const sale = await getFoundationLastSale(client, contract, BigInt(tokenId))
    if (!sale) return null
    return {
      platform: "foundation",
      priceWei: sale.priceWei,
      blockTime: sale.blockTime,
      source: sale.source, // "foundation" — narrowed at orchestrator
      txHash: sale.txHash,
    }
  },

  async getCancellableListingsForSeller(): Promise<SellerListings | null> {
    return null
  },

  async getBidHistory() {
    return null
  },
}
