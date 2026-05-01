import { revalidateTag } from "next/cache"
import { NextRequest, NextResponse } from "next/server"
import { pgCacheInvalidate } from "@/lib/pg-cache"

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
 * affected seller. IP rate limit is sufficient.
 */

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_PER_WINDOW = 30

type Counter = { count: number; windowStart: number }
const counts: Map<string, Counter> = (
  globalThis as unknown as {
    __pndSellerListingsRevalLimiter?: Map<string, Counter>
  }
).__pndSellerListingsRevalLimiter ??
  ((
    globalThis as unknown as {
      __pndSellerListingsRevalLimiter?: Map<string, Counter>
    }
  ).__pndSellerListingsRevalLimiter = new Map())

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return req.headers.get("x-real-ip") ?? "unknown"
}

function rateLimit(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()
  if (counts.size > 5000) {
    for (const [k, c] of counts) {
      if (now - c.windowStart > RATE_LIMIT_WINDOW_MS) counts.delete(k)
    }
  }
  const c = counts.get(ip)
  if (!c || now - c.windowStart > RATE_LIMIT_WINDOW_MS) {
    counts.set(ip, { count: 1, windowStart: now })
    return { ok: true }
  }
  if (c.count >= RATE_LIMIT_MAX_PER_WINDOW) {
    const retryAfter = Math.ceil(
      (RATE_LIMIT_WINDOW_MS - (now - c.windowStart)) / 1000,
    )
    return { ok: false, retryAfter }
  }
  c.count++
  return { ok: true }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const rl = rateLimit(ip)
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate-limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

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
