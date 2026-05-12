import { NextResponse } from "next/server"
import { unstable_cache } from "next/cache"
import { pgCache } from "@/lib/pg-cache"
import { PLATFORMS } from "@/lib/platforms"
import type {
  SellerCancellableAuction,
  SellerCancellableBuyNow,
} from "@/lib/platforms/types"
import type { Address } from "viem"

/**
 * Multi-platform cancellable-listings API. Fans out across every
 * registered `PlatformAdapter` that implements
 * `getCancellableListingsForSeller`, merges the platform-tagged rows
 * into a single payload, and caches the merged result.
 *
 * Each adapter handles its own per-platform cache (Foundation has a
 * lazy DB row in `lazy_fnd_seller_listings`; SuperRare V2 relies on
 * the route's pgCache + indexed-arg event scans). The route's
 * `unstable_cache` + `pgCache` collapse repeated panel opens to a
 * Postgres point read at 1-hour granularity.
 *
 * TTL is 1 hour because the underlying SR scan is ~50 `eth_getLogs`
 * calls — re-scanning every 5 min meant the same seller's listings
 * triggered a fresh fan-out for every panel open across the day.
 * 1 hour is long enough that revisiting a delist panel is cheap, short
 * enough that stale data (a cancel made elsewhere) self-heals within
 * a reasonable window. The bulk-cancel flow invalidates this tag on
 * commit (via `revalidateTag("seller-listings")`) so the user's own
 * action shows up immediately.
 *
 * Bigints are serialized to decimal strings at the cache + JSON
 * boundary because pgCache JSON-stringifies and `JSON.stringify(bigint)`
 * throws.
 */

type SerializedAuction = {
  kind: "auction"
} & SellerCancellableAuction

type SerializedBuyNow = {
  kind: "buyNow"
} & SellerCancellableBuyNow

export type SellerListingsPayload = {
  auctions: SerializedAuction[]
  buyNows: SerializedBuyNow[]
}

const SELLER_LISTINGS_TTL_S = 60 * 60

// Each adapter gets a hard budget per request. Two reasons:
//   1. Netlify functions cap at 10s on the default tier. If any adapter
//      takes that long, the whole route 502s and the user sees a
//      "seller-listings 502" error in the panel.
//   2. One slow platform shouldn't blank the whole result. If SR's
//      RPC fan-out spikes, we still return whatever Foundation and
//      Sovereign came back with.
const PER_ADAPTER_TIMEOUT_MS = 7_000

// Tell Next.js / Netlify the route is allowed up to 26s — buys headroom
// over the per-adapter timeout for cold pgCache writes and JSON
// serialization, without inheriting the platform's default 10s ceiling.
export const maxDuration = 26

async function buildPayload(sellerAddress: string): Promise<{
  payload: SellerListingsPayload
  complete: boolean
}> {
  // Fan out across platforms. Each adapter is responsible for its own
  // per-platform cache; an adapter that doesn't implement the optional
  // method (Manifold today) is silently skipped.
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

// Cached fetch: only the cache path runs `buildPayload`, and it throws
// on a partial result so neither L1 (unstable_cache) nor L2 (pgCache)
// stores the partial. The route handler catches the throw and falls
// through to a fresh uncached scan so the user still gets data.
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

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse<SellerListingsPayload | { error: string }>> {
  const { address } = await ctx.params
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }
  const seller = address.toLowerCase()
  try {
    const data = await cachedComplete(seller)
    return NextResponse.json(data)
  } catch (e) {
    // `partial` is thrown by `cachedComplete` when one of the platform
    // adapters timed out. Re-run buildPayload uncached and return what
    // we got — better for the user than 502'ing the whole panel just
    // because one platform's RPC fan-out was slow on this request.
    if (e instanceof Error && e.message === "partial") {
      const { payload } = await buildPayload(seller)
      return NextResponse.json(payload, {
        headers: { "x-seller-listings-partial": "1" },
      })
    }
    throw e
  }
}
