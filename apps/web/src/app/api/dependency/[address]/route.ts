import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import {
  getDependencyReport,
  type DependencyReport,
} from "@/lib/dependency-check"

/**
 * Artist Dependency Check scan report. Every check is indexer-backed; the
 * route never falls back to live RPC for the indexed cards. The cached
 * wrapper lives in `@/lib/dependency-check` so the server-side result
 * page shares the same two-layer cache (`unstable_cache` over `pgCache`).
 *
 * Per-IP rate limit is more conservative than the artist-tokens route
 * (10/min vs 30/min) because a brand-new address pays the cold-cache
 * cost of the seller-listings fan-out.
 */

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse<DependencyReport | { error: string }>> {
  const { address } = await ctx.params

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }

  const ip = getClientIp(req)
  const rl = checkRateLimit("artist-dependency", ip, 60_000, 10)
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  try {
    const data = await getDependencyReport(address.toLowerCase())
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, max-age=60" },
    })
  } catch (err) {
    console.error("dependency-check failed:", err)
    return NextResponse.json({ error: "scan failed" }, { status: 500 })
  }
}
