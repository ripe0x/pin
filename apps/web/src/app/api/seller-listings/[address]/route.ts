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

async function buildPayload(
  sellerAddress: string,
): Promise<SellerListingsPayload> {
  // Fan out across platforms. Each adapter is responsible for its own
  // per-platform cache; an adapter that doesn't implement the optional
  // method (Manifold today) is silently skipped.
  const seller = sellerAddress.toLowerCase() as Address
  const results = await Promise.all(
    PLATFORMS.map(async (p) => {
      if (!p.getCancellableListingsForSeller) return null
      try {
        return await p.getCancellableListingsForSeller(seller)
      } catch {
        // One platform failing shouldn't blank the whole panel — just
        // omit its rows. The user will see the others and can retry.
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

const cached = unstable_cache(
  (sellerAddress: string) =>
    pgCache<SellerListingsPayload>(
      `seller-listings:${sellerAddress}`,
      SELLER_LISTINGS_TTL_S,
      () => buildPayload(sellerAddress),
    ),
  ["seller-listings-v2"],
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
  const data = await cached(address.toLowerCase())
  return NextResponse.json(data)
}
