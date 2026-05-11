import "server-only"
import { unstable_cache } from "next/cache"
import type { Address } from "viem"
import { pgCache } from "./pg-cache"
import { PLATFORMS } from "./platforms"
import type {
  PlatformId,
  SellerCancellableAuction,
  SellerCancellableBuyNow,
} from "./platforms/types"

/**
 * Server-side helper for cancellable seller-listings, factored out of
 * `/api/seller-listings/[address]/route.ts` so other server-side callers
 * (the dependency-check orchestrator) can hit the same two-layer cache
 * without a self-HTTP round-trip.
 *
 * Cache layering and TTL match the route exactly; this module IS the
 * cached path the route serves from.
 */

export type SerializedAuction = {
  kind: "auction"
} & SellerCancellableAuction

export type SerializedBuyNow = {
  kind: "buyNow"
} & SellerCancellableBuyNow

export type SellerListingsPayload = {
  auctions: SerializedAuction[]
  buyNows: SerializedBuyNow[]
}

export const SELLER_LISTINGS_TTL_S = 5 * 60

async function buildPayload(
  sellerAddress: string,
): Promise<SellerListingsPayload> {
  const seller = sellerAddress.toLowerCase() as Address
  const results = await Promise.all(
    PLATFORMS.map(async (p) => {
      if (!p.getCancellableListingsForSeller) return null
      try {
        return await p.getCancellableListingsForSeller(seller)
      } catch {
        return null
      }
    }),
  )

  const auctions: SerializedAuction[] = []
  const buyNows: SerializedBuyNow[] = []
  for (const r of results) {
    if (!r) continue
    for (const a of r.auctions) auctions.push({ kind: "auction", ...a })
    for (const b of r.buyNows) buyNows.push({ kind: "buyNow", ...b })
  }
  return { auctions, buyNows }
}

export const getSellerListingsPayload = unstable_cache(
  (sellerAddress: string) =>
    pgCache<SellerListingsPayload>(
      `seller-listings:${sellerAddress}`,
      SELLER_LISTINGS_TTL_S,
      () => buildPayload(sellerAddress),
    ),
  ["seller-listings-v2"],
  { revalidate: SELLER_LISTINGS_TTL_S, tags: ["seller-listings"] },
)

/**
 * Count active listings (auctions + buy-nows) grouped by platform.
 */
export function countByPlatform(
  payload: SellerListingsPayload,
): Record<PlatformId, { auctions: number; buyNows: number }> {
  const empty = () => ({ auctions: 0, buyNows: 0 })
  const out: Partial<Record<PlatformId, { auctions: number; buyNows: number }>> =
    {}
  for (const a of payload.auctions) {
    const slot = (out[a.platform] ??= empty())
    slot.auctions++
  }
  for (const b of payload.buyNows) {
    const slot = (out[b.platform] ??= empty())
    slot.buyNows++
  }
  return out as Record<PlatformId, { auctions: number; buyNows: number }>
}
