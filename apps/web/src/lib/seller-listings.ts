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
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem"
import { mainnet } from "viem/chains"
import { erc721Abi } from "@pin/abi"
import { ipfsToHttp } from "@pin/shared"
import type { PlatformId } from "@/lib/platforms/types"
import { getAlchemyMainnetUrl } from "./alchemy-rpc"

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

function getClient(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      getAlchemyMainnetUrl(),
    ),
  })
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
 * Resolve display name + image for a batch of listings via tokenURI + IPFS.
 * Errors per token are swallowed — caller gets a placeholder display.
 */
export async function resolveListingMetadata(
  listings: SellerListing[],
): Promise<Map<string, SellerListingMeta>> {
  const client = getClient()
  const out = new Map<string, SellerListingMeta>()
  if (listings.length === 0) return out

  // Batch tokenURI calls in chunks of 50 (mirrors onchain-discovery.ts).
  for (let i = 0; i < listings.length; i += 50) {
    const batch = listings.slice(i, i + 50)
    const results = await client.multicall({
      contracts: batch.map((l) => ({
        address: l.nftContract,
        abi: erc721Abi,
        functionName: "tokenURI" as const,
        args: [BigInt(l.tokenId)] as const,
      })),
    })

    await Promise.all(
      batch.map(async (l, j) => {
        const r = results[j]
        const fallback: SellerListingMeta = {
          displayName: `#${l.tokenId}`,
          imageUrl: null,
        }
        if (r.status !== "success") {
          out.set(l.id, fallback)
          return
        }
        const uri = r.result as string
        if (!uri) {
          out.set(l.id, fallback)
          return
        }
        try {
          const res = await fetch(ipfsToHttp(uri), {
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) {
            out.set(l.id, fallback)
            return
          }
          const meta = (await res.json()) as {
            name?: string
            image?: string
          }
          out.set(l.id, {
            displayName: meta.name ?? fallback.displayName,
            imageUrl: meta.image ? ipfsToHttp(meta.image) : null,
          })
        } catch {
          out.set(l.id, fallback)
        }
      }),
    )
  }

  return out
}

