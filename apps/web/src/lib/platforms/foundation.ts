import "server-only"
import { createPublicClient, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { FOUNDATION_NFT, NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import type {
  PlatformAdapter,
  ArtistTokenRef,
  CollectorTokenRef,
  AdapterLastSale,
  SellerListings,
  ActiveAuctionSummary,
} from "./types"
import { discoverFoundationArtistRefs } from "../onchain-discovery"
import { getFoundationLastSale } from "../last-sale"
import { getNFTsForOwner } from "../alchemy"
import { sql } from "../db"
import {
  readFoundationCollectorTokens,
  writeFoundationCollectorTokens,
  readFoundationSellerListings,
  writeFoundationSellerListings,
  readFoundationActiveAuctions,
  LAZY_TTL,
  isFresh,
} from "../lazy-index"
import { discoverFoundationCancellableListings } from "./foundation-seller-listings"
import { discoverFoundationArtistAuctions } from "./foundation-scan"
import { getAlchemyMainnetUrl } from "../alchemy-rpc"

const FOUNDATION_NFT_ADDRESS = FOUNDATION_NFT[MAINNET_CHAIN_ID]
const FND_NFT_MARKET = NFT_MARKET[MAINNET_CHAIN_ID]

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      getAlchemyMainnetUrl(),
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

  /**
   * Lazy-cached fan-out target for the `/api/seller-listings/[address]`
   * route. Reads `lazy_fnd_seller_listings` first; misses run the RPC
   * scan in `discoverFoundationCancellableListings` and fire-and-forget
   * the row back. The route's `unstable_cache` + `pgCache` layers handle
   * the merged-payload cache; this layer keeps Foundation-specific data
   * warm independently so a cold fan-out doesn't always pay two scans.
   */
  async getCancellableListingsForSeller(
    seller: Address,
  ): Promise<SellerListings | null> {
    const sellerLower = seller.toLowerCase()
    const cached = await readFoundationSellerListings(sellerLower)
    if (
      cached &&
      isFresh(cached.lastIndexedAt, LAZY_TTL.foundationSellerListings)
    ) {
      return {
        auctions: cached.auctions.map((a) => ({
          id: a.id,
          platform: "foundation",
          auctionId: a.auctionId,
          nftContract: a.nftContract,
          tokenId: a.tokenId,
          reserveWei: a.reserveWei,
          durationSeconds: a.durationSeconds,
        })),
        buyNows: cached.buyNows.map((b) => ({
          id: b.id,
          platform: "foundation",
          nftContract: b.nftContract,
          tokenId: b.tokenId,
          priceWei: b.priceWei,
        })),
      }
    }

    const fresh = await discoverFoundationCancellableListings(sellerLower)
    writeFoundationSellerListings(sellerLower, {
      auctions: fresh.auctions.map((a) => ({
        id: a.id,
        auctionId: a.auctionId,
        nftContract: a.nftContract,
        tokenId: a.tokenId,
        reserveWei: a.reserveWei,
        durationSeconds: a.durationSeconds,
      })),
      buyNows: fresh.buyNows.map((b) => ({
        id: b.id,
        nftContract: b.nftContract,
        tokenId: b.tokenId,
        priceWei: b.priceWei,
      })),
    })
    return fresh
  },

  async getBidHistory() {
    return null
  },

  async discoverArtistAuctions(artist: Address): Promise<void> {
    await discoverFoundationArtistAuctions(artist)
  },

  async getActiveAuctions(limit: number): Promise<ActiveAuctionSummary[]> {
    // Pure table read — no RPC in the home-grid request path. The
    // per-artist scanner runs from artist-page loads via
    // `discoverArtistAuctions`, populating the table for whoever's
    // been visited. Reads JOIN the per-artist status table with a
    // 24h freshness filter so unvisited artists drop out.
    // Over-read so the artist-seller filter doesn't shrink the result
    // set below `limit` when many active rows are secondary listings.
    const rows = await readFoundationActiveAuctions(limit * 4)
    return rows
      .filter(
        (r) =>
          r.creator !== null &&
          r.creator.toLowerCase() === r.seller.toLowerCase(),
      )
      .slice(0, limit)
      .map((r) => ({
        platform: "foundation",
        contract: r.contract as Address,
        tokenId: r.tokenId,
        seller: r.seller as Address,
        reserveWei: r.reserveWei,
        currentBidWei: r.currentBidWei,
        currentBidder: (r.currentBidder ?? null) as Address | null,
        endTime: r.endTime,
        sourceContract: FND_NFT_MARKET,
      }))
  },
}
