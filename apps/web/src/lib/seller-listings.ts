/**
 * Client-safe seller-listings types and helpers. The actual cross-platform
 * RPC discovery now lives in each platform adapter (`platforms/<id>.ts`)
 * and is fanned-out by the `/api/seller-listings/[address]` route. This
 * module exposes:
 *
 *   - The deserialized listing types (`AuctionListing`, `BuyNowListing`,
 *     `SellerListing`) the UI components consume.
 *   - `fetchSellerCancellableListings` — client fetcher that hits the API
 *     route and hydrates bigints.
 *   - `resolveListingMetadata` — client-callable tokenURI + IPFS
 *     resolver shared by the migrate / bulk-delist panels.
 *
 * Adding a new platform (e.g. SuperRare V1, Zora) requires no changes
 * here: the adapter implements `getCancellableListingsForSeller`, and the
 * `platform` discriminator on each row lets the client dispatch cancels
 * via `cancel-calls.ts` (`buildCancelCall(listing)`).
 */
import type { Address } from "viem"
import type { PlatformId } from "@/lib/platforms/types"

export type AuctionListing = {
  kind: "auction"
  /** Discriminator for cancel-call dispatch. */
  platform: PlatformId
  /** Unique row identifier across all platforms. */
  id: string
  /**
   * Platform-defined identifier passed to the cancel call. Foundation
   * stores the numeric NFTMarket auctionId; SuperRare V2 packs
   * `<contract>:<tokenId>` since Bazaar's cancel takes `(contract, tokenId)`
   * directly.
   */
  auctionId: string
  nftContract: Address
  tokenId: string
  reserveWei: bigint
  /**
   * Original auction duration in seconds. Used by MigratePanel to prefill
   * the snapped duration when migrating onto a Sovereign auction house.
   * SuperRare returns the configured `lengthOfAuction`; Foundation reads
   * it off the original `ReserveAuctionCreated` event.
   */
  durationSeconds: number
  /**
   * Source-platform fee in basis points (10000 = 100%) when the adapter
   * computed it precisely for this token. Optional — see types.ts.
   */
  feeBps?: number
}

export type BuyNowListing = {
  kind: "buyNow"
  platform: PlatformId
  id: string
  nftContract: Address
  tokenId: string
  priceWei: bigint
}

export type SellerListing = AuctionListing | BuyNowListing

export type SellerListingMeta = {
  displayName: string
  imageUrl: string | null
}

/**
 * Client-side fetcher. Hits the cached API route which fans out across all
 * platform adapters and returns a unified, platform-tagged list. All
 * panel components consume this rather than calling adapters directly.
 *
 * The `partial` flag is true when the route returned an incomplete
 * result — at least one platform adapter timed out or upstream RPC
 * failed. Callers should surface this so users know empty results may
 * be a scan failure, not an actual absence of listings. The route
 * deliberately does NOT cache partial results, so the next refresh
 * runs fresh.
 */
export async function fetchSellerCancellableListings(
  sellerAddress: string,
): Promise<{
  auctions: AuctionListing[]
  buyNows: BuyNowListing[]
  partial: boolean
}> {
  const res = await fetch(
    `/api/seller-listings/${sellerAddress.toLowerCase()}`,
    { cache: "no-store" },
  )
  if (!res.ok) throw new Error(`seller-listings ${res.status}`)
  const partial = res.headers.get("x-seller-listings-partial") === "1"
  const json = (await res.json()) as {
    auctions: Array<{
      kind: "auction"
      platform: PlatformId
      id: string
      auctionId: string
      nftContract: string
      tokenId: string
      reserveWei: string
      durationSeconds: number
      feeBps?: number
    }>
    buyNows: Array<{
      kind: "buyNow"
      platform: PlatformId
      id: string
      nftContract: string
      tokenId: string
      priceWei: string
    }>
  }
  return {
    auctions: json.auctions.map((a) => ({
      kind: "auction",
      platform: a.platform,
      id: a.id,
      auctionId: a.auctionId,
      nftContract: a.nftContract as Address,
      tokenId: a.tokenId,
      reserveWei: BigInt(a.reserveWei),
      durationSeconds: a.durationSeconds,
      feeBps: a.feeBps,
    })),
    buyNows: json.buyNows.map((b) => ({
      kind: "buyNow",
      platform: b.platform,
      id: b.id,
      nftContract: b.nftContract as Address,
      tokenId: b.tokenId,
      priceWei: BigInt(b.priceWei),
    })),
    partial,
  }
}

/**
 * Resolve display name + image for a batch of listings.
 *
 * Routes each token through the server-side `/api/meta/[contract]/[tokenId]`
 * endpoint rather than hitting IPFS gateways from the browser. Three
 * reasons: (1) the route is wrapped in unstable_cache + 1-year HTTP cache,
 * so warm hits are instant; (2) the server bypasses the CORS / 302-chain
 * issues that block browser-side fetches to nftstorage.link; (3) the
 * tokenURI multicall happens once per token on the server and is reused
 * across every visitor.
 *
 * Errors per token are swallowed — caller gets a `#<tokenId>` fallback.
 */
export async function resolveListingMetadata(
  listings: SellerListing[],
): Promise<Map<string, SellerListingMeta>> {
  const out = new Map<string, SellerListingMeta>()
  if (listings.length === 0) return out

  // Concurrency-limit so a seller with hundreds of listings doesn't burst
  // past the route's per-IP rate limit (120/min). 16 in flight keeps a
  // 68-listing page warm in ~1 round-trip.
  const CONCURRENCY = 16
  let cursor = 0
  async function worker() {
    while (cursor < listings.length) {
      const i = cursor++
      const l = listings[i]
      const fallback: SellerListingMeta = {
        displayName: `#${l.tokenId}`,
        imageUrl: null,
      }
      try {
        const r = await fetch(
          `/api/meta/${l.nftContract}/${l.tokenId}`,
          { signal: AbortSignal.timeout(12_000) },
        )
        if (!r.ok) { out.set(l.id, fallback); continue }
        const body = (await r.json()) as {
          metadata: { name?: string; image?: string } | null
          mediaUri: string | null
        }
        if (!body.metadata) { out.set(l.id, fallback); continue }
        out.set(l.id, {
          displayName: body.metadata.name ?? fallback.displayName,
          imageUrl: body.mediaUri,
        })
      } catch {
        out.set(l.id, fallback)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, listings.length) }, worker),
  )

  return out
}

