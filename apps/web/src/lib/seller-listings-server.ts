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
 *
 * Cache only stores complete results — if one of the platform adapters
 * times out or fails, the partial payload is returned to the caller but
 * never persisted, so the next request retries from scratch instead of
 * locking in a half-empty list for an hour.
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

export const SELLER_LISTINGS_TTL_S = 60 * 60

// Each adapter gets a hard budget per request. Two reasons:
//   1. Netlify functions cap at 10s on the default tier. If any adapter
//      takes that long, the whole route 502s and the user sees a
//      "seller-listings 502" error in the panel.
//   2. One slow platform shouldn't blank the whole result. If SR's
//      RPC fan-out spikes, we still return whatever Foundation and
//      Sovereign came back with.
const PER_ADAPTER_TIMEOUT_MS = 7_000

async function withDeadline<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`adapter timed out after ${ms}ms`)), ms),
    ),
  ])
}

async function buildPayload(sellerAddress: string): Promise<{
  payload: SellerListingsPayload
  complete: boolean
}> {
  const seller = sellerAddress.toLowerCase() as Address
  let complete = true
  const results = await Promise.all(
    PLATFORMS.map(async (p) => {
      if (!p.getCancellableListingsForSeller) return null
      try {
        return await withDeadline(
          () => p.getCancellableListingsForSeller!(seller),
          PER_ADAPTER_TIMEOUT_MS,
        )
      } catch {
        // Adapter failed or timed out — mark partial so the caller skips
        // caching. The user will see the platforms that did succeed.
        complete = false
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
  return { payload: { auctions, buyNows }, complete }
}

// Cached fetch: only the cache path runs `buildPayload`, and it throws
// on a partial result so neither L1 (unstable_cache) nor L2 (pgCache)
// stores the partial. Callers catch the throw and fall through to a
// fresh uncached scan so the user still gets data.
const cachedComplete = unstable_cache(
  (sellerAddress: string) =>
    pgCache<SellerListingsPayload>(
      `seller-listings:${sellerAddress}`,
      SELLER_LISTINGS_TTL_S,
      async () => {
        const result = await buildPayload(sellerAddress)
        if (!result.complete) throw new Error("partial")
        return result.payload
      },
    ),
  ["seller-listings-v3"],
  { revalidate: SELLER_LISTINGS_TTL_S, tags: ["seller-listings"] },
)

/**
 * Resolve a seller's cancellable listings, complete or partial. Tries
 * the cache first; on a partial-result throw, re-runs buildPayload
 * uncached so the user still sees what did come back rather than 502'ing
 * the whole panel because one platform's RPC fan-out was slow.
 *
 * Returns just the payload — the partial-vs-complete distinction is
 * absorbed here because no downstream caller currently surfaces it.
 */
export async function getSellerListingsPayload(
  sellerAddress: string,
): Promise<SellerListingsPayload> {
  const seller = sellerAddress.toLowerCase()
  try {
    return await cachedComplete(seller)
  } catch (e) {
    if (e instanceof Error && e.message === "partial") {
      const { payload } = await buildPayload(seller)
      return payload
    }
    throw e
  }
}

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
