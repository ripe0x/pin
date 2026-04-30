import "server-only"
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { FOUNDATION_NFT, MAINNET_CHAIN_ID } from "@pin/addresses"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  CollectorTokenRef,
  AdapterLastSale,
  SellerListings,
} from "./types"
import { discoverFoundationArtistRefs } from "../onchain-discovery"
import { getFoundationLastSale } from "../last-sale"
import { getNFTsForOwner } from "../alchemy"
import { sql } from "../db"
import {
  readFoundationCollectorTokens,
  writeFoundationCollectorTokens,
  LAZY_TTL,
  isFresh,
} from "../lazy-index"

const FOUNDATION_NFT_ADDRESS = FOUNDATION_NFT[MAINNET_CHAIN_ID]

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

  async discoverCollectorTokens(
    wallet: Address,
  ): Promise<CollectorTokenRef[]> {
    // Lazy read first.
    const cached = await readFoundationCollectorTokens(wallet)
    if (cached && isFresh(cached.lastIndexedAt, LAZY_TTL.foundationCollectorTokens)) {
      return cached.tokens.map((t) => ({
        platform: "foundation",
        contract: t.contract as Address,
        tokenId: t.tokenId,
        ownerWallet: wallet,
        acquiredAtBlock: t.acquiredAtBlock,
        acquiredTxHash: t.acquiredTxHash,
      }))
    }

    // Build the list of Foundation contracts we know about: the shared
    // 1/1 contract + every per-artist collection we've discovered via
    // artist-gallery views (lazy_fnd_artist_tokens.contract).
    const contracts = new Set<string>([FOUNDATION_NFT_ADDRESS.toLowerCase()])
    if (sql) {
      try {
        const rows = await sql<Array<{ contract: string }>>`
          SELECT DISTINCT contract FROM lazy_fnd_artist_tokens
        `
        for (const r of rows) contracts.add(r.contract.toLowerCase())
      } catch {
        /* DB transient — proceed with just the shared contract */
      }
    }
    const contractList = [...contracts]

    // Alchemy NFT API tracks current ownership; one paginated call (or
    // batched if > 45 contracts) returns the wallet's owned tokens
    // across all known Foundation contracts. No per-token ownerOf
    // re-check needed.
    const owned = await getNFTsForOwner(wallet, contractList)

    const refs: CollectorTokenRef[] = owned.map((o) => ({
      platform: "foundation",
      contract: o.contract as Address,
      tokenId: o.tokenId,
      ownerWallet: wallet,
      // NFT API doesn't surface acquisition block; collector display
      // only needs current ownership. 0n is the sentinel.
      acquiredAtBlock: 0n,
      acquiredTxHash: null,
    }))

    writeFoundationCollectorTokens(
      wallet,
      refs.map((r) => ({
        contract: r.contract,
        tokenId: r.tokenId,
        acquiredAtBlock: r.acquiredAtBlock,
        acquiredTxHash: r.acquiredTxHash,
      })),
    )
    return refs
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
