import "server-only"
import type { Address } from "viem"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  CollectorTokenRef,
  AdapterLastSale,
} from "./types"
import { getMintTokensFromIndexer } from "../indexer-queries"

/**
 * Mint protocol (Visualize Value) platform adapter.
 *
 * As of the Ponder migration, this adapter is pure-read against
 * `ponder_v*.mint_artist_tokens`, which Ponder populates in real time
 * from Factory `Created` events plus per-clone `TransferSingle` /
 * `TransferBatch` from address(0). See `ponder/src/Mint.ts` for the
 * indexer handlers. The previous web-app-side scan path
 * (`scanMintArtistTokens`, `lazy_mint_*` tables, `mint_creators`
 * public table) is gone — migration 028 drops what's left of those.
 *
 * Mint has no marketplace integration today — collection contracts
 * are ERC-1155s with fixed-price mints handled inside the contract
 * itself; there's no auction-house event stream to surface in our
 * home grid or token-detail bid panel. `getLastSale` returns null
 * (same as Manifold).
 */
export const mintAdapter: PlatformAdapter = {
  id: "mint",
  displayName: "Mint",

  async discoverArtistTokens(artist: Address): Promise<ArtistTokenRef[]> {
    const refs = await getMintTokensFromIndexer(artist)
    if (!refs) return []
    return refs.map((r) => ({
      platform: "mint",
      contract: r.contract as Address,
      tokenId: r.tokenId,
      blockNumber: r.blockNumber,
      logIndex: r.logIndex,
      collectionName: null,
    }))
  },

  async discoverCollectorTokens(): Promise<CollectorTokenRef[]> {
    // Collector-side enumeration deferred — would need an Alchemy NFT
    // API ownership query gated by the Mint-contract classifier. Out
    // of scope for parity with the initial Manifold/SR/TL feature set.
    return []
  },

  async getLastSale(): Promise<AdapterLastSale | null> {
    // No marketplace integration today (see adapter docstring).
    return null
  },
}
