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
  type LazySellerListings,
  LAZY_TTL,
  isFresh,
} from "../lazy-index"
import {
  discoverFoundationCancellableListings,
  type FndDiscoveryCache,
} from "./foundation-seller-listings"
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
 * Convert a cached `lazy_fnd_seller_listings` row into the shape
 * `discoverFoundationCancellableListings` expects as its merge baseline,
 * so the incremental refresh can layer new `(fromBlock, latest)` events
 * on top instead of re-scanning history from the NFTMarket deploy block.
 * The multicall layer downstream re-confirms cancellable state on every
 * candidate, so any cached entries that were settled or cancelled in
 * the gap drop out naturally.
 */
function fndCachedToDiscoveryCache(
  cached: LazySellerListings,
): FndDiscoveryCache {
  const durationByAuctionId = new Map<bigint, bigint>()
  for (const a of cached.auctions) {
    try {
      durationByAuctionId.set(
        BigInt(a.auctionId),
        BigInt(a.durationSeconds),
      )
    } catch {
      // Defensive: skip cached rows with malformed auctionId. The next
      // refresh will pick them up via the live scan if they're still
      // live, or correctly drop them if not.
    }
  }
  const buyNowKeys = new Map<
    string,
    { nftContract: Address; tokenId: bigint }
  >()
  for (const b of cached.buyNows) {
    try {
      const key = `${b.nftContract.toLowerCase()}:${b.tokenId}`
      buyNowKeys.set(key, {
        nftContract: b.nftContract as Address,
        tokenId: BigInt(b.tokenId),
      })
    } catch {
      // Same defensive skip — bad cached row drops out and gets
      // re-resolved next refresh.
    }
  }
  return {
    auctionIds: Array.from(durationByAuctionId.keys()),
    durationByAuctionId,
    buyNowKeys,
  }
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

    // Incremental refresh. Existing rows without a `lastScannedBlock`
    // (pre-incremental-column writes) fall back to a full rescan once,
    // then settle into incremental mode on subsequent refreshes.
    const cachedContext = cached ? fndCachedToDiscoveryCache(cached) : undefined
    const fromBlock =
      cached?.lastScannedBlock != null ? cached.lastScannedBlock + 1n : undefined
    const { listings, scannedTo } = await discoverFoundationCancellableListings(
      sellerLower,
      { fromBlock, cached: cachedContext },
    )
    writeFoundationSellerListings(sellerLower, {
      auctions: listings.auctions.map((a) => ({
        id: a.id,
        auctionId: a.auctionId,
        nftContract: a.nftContract,
        tokenId: a.tokenId,
        reserveWei: a.reserveWei,
        durationSeconds: a.durationSeconds,
      })),
      buyNows: listings.buyNows.map((b) => ({
        id: b.id,
        nftContract: b.nftContract,
        tokenId: b.tokenId,
        priceWei: b.priceWei,
      })),
      lastScannedBlock: scannedTo,
    })
    return listings
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
