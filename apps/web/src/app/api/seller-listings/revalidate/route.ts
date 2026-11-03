import { revalidateTag } from "next/cache"
import { NextRequest, NextResponse } from "next/server"
import { pgCacheInvalidate } from "@/lib/pg-cache"
import { rateLimitResponse } from "@/lib/rate-limit"

/**
 * Surgically invalidate the cached seller-listings entry for one seller.
 *
 * Why this exists: `/api/seller-listings/[address]` is wrapped in a 5-min
 * `unstable_cache` + `pgCache`. After a user clicks Delist & relist and the
 * cancel tx confirms, the on-chain state changes — but our cache still
 * returns the row that was just cancelled. The next page reload (or even a
 * stale in-flight fetch on the same panel) shows the migrated row again,
 * and the user can re-click → SR/FND reverts with "no auction configured".
 *
 * MigratePanel calls this after each successful row migration. We
 * revalidate the global `seller-listings` tag (cheap — only affects N
 * artists currently looking at their migrate panel) and drop this seller's
 * Postgres row so cross-sandbox readers also see fresh state.
 *
 * Auth model: open POST. Same risk profile as `/api/auction/revalidate` —
 * worst case is forced cache miss, which costs one extra RPC fan-out per
 * affected seller. The shared per-IP rate limit (lib/rate-limit.ts) bounds it.
 */

export async function POST(req: NextRequest) {
  const limited = await rateLimitResponse(req, {
    namespace: "seller-listings-revalidate",
    windowMs: 60_000,
    max: 30,
  })
  if (limited) return limited

  const seller = req.nextUrl.searchParams.get("seller")
  if (!seller || !/^0x[0-9a-fA-F]{40}$/.test(seller)) {
    return NextResponse.json(
      { ok: false, error: "seller must be a 0x address" },
      { status: 400 },
    )
  }

  const sellerLower = seller.toLowerCase()
  // Flush both layers: L1 (in-process unstable_cache) via tag, and L2
  // (Postgres pgCache) via the per-seller key.
  revalidateTag("seller-listings")
  await pgCacheInvalidate(`seller-listings:${sellerLower}`)
  return NextResponse.json({ ok: true, seller: sellerLower })
}
