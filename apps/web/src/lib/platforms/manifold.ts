import "server-only"
import type { Address } from "viem"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  AdapterLastSale,
} from "./types"
import { discoverManifoldTokenRefs } from "../manifold-discovery"

/**
 * Manifold platform adapter. Wraps `discoverManifoldTokenRefs` (which
 * already does its own lazy read/write through `lazy_manifold_artist_*`
 * tables). Manifold doesn't have on-chain marketplace events we index —
 * sales happen on Manifold's relay/Crossmint contracts that we don't
 * track yet — so `getLastSale` returns null. Callers fall back to
 * whatever other platform's marketplace surfaces a sale for the token.
 */
export const manifoldAdapter: PlatformAdapter = {
  id: "manifold",
  displayName: "Manifold",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    const refs = await discoverManifoldTokenRefs(artist)
    return refs.map((r) => ({
      platform: "manifold",
      contract: r.contract,
      tokenId: r.tokenId,
      blockNumber: null, // NFT API doesn't surface log context
      logIndex: null,
      collectionName: r.collectionName,
    }))
  },

  async getLastSale(): Promise<AdapterLastSale | null> {
    // No marketplace integration today.
    return null
  },
}
