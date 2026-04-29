import { revalidateTag } from "next/cache"
import { NextRequest, NextResponse } from "next/server"
import { isAddress } from "viem"
import { auctionTokenTag } from "@/lib/auctions"
import { pgCacheInvalidate } from "@/lib/pg-cache"

/**
 * Surgically revalidate the cached `getAuctionForToken` entry for one token.
 *
 * Why this exists: `getAuctionForToken` is cached for 30s so anonymous /
 * refresh traffic doesn't rescan auction state on every render. But the
 * person who *just bid* or *just settled* should see the new state
 * immediately, not 30s later. The bid/settle paths in `AuctionPanel.tsx`
 * call this route after `useWaitForTransactionReceipt` resolves; we
 * `revalidateTag` the per-token tag, the next render fetches fresh, and the
 * bidder sees their bid land instantly.
 *
 * Auth model: open. The worst-case abuse is "an attacker forces our cache to
 * miss" — which costs us at most one extra RPC fan-out per token per
 * revalidate call. Not free, but bounded by RPC rate limits, and the same
 * person could just hit `/api/rpc` directly. We rate-limit by IP anyway via
 * the same in-memory limiter pattern used elsewhere.
 *
 * Usage from the client (after a bid/settle tx confirms):
 *   await fetch(
 *     `/api/auction/revalidate?contract=${contract}&tokenId=${tokenId}`,
 *     { method: "POST" },
 *   )
 */

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_PER_WINDOW = 30 // user shouldn't bid > 30x/min

type Counter = { count: number; windowStart: number }
const counts: Map<string, Counter> = (
  globalThis as unknown as { __pndAuctionRevalLimiter?: Map<string, Counter> }
).__pndAuctionRevalLimiter ??
  ((
    globalThis as unknown as { __pndAuctionRevalLimiter?: Map<string, Counter> }
  ).__pndAuctionRevalLimiter = new Map())

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

  const contract = req.nextUrl.searchParams.get("contract")
  const tokenId = req.nextUrl.searchParams.get("tokenId")
  if (!contract || !tokenId) {
    return NextResponse.json(
      { ok: false, error: "contract and tokenId required" },
      { status: 400 },
    )
  }
  if (!isAddress(contract)) {
    return NextResponse.json(
      { ok: false, error: "contract is not a valid address" },
      { status: 400 },
    )
  }
  // tokenId can be huge (uint256), so just sanity-check it's digits.
  if (!/^\d+$/.test(tokenId)) {
    return NextResponse.json(
      { ok: false, error: "tokenId must be a decimal integer" },
      { status: 400 },
    )
  }

  const tag = auctionTokenTag(contract, tokenId)
  // Flush both layers: L1 (in-process unstable_cache) via tag, and L2
  // (Postgres pgCache) via the same key prefix. Either layer alone would
  // be enough for the bidder's own next render in the same sandbox, but
  // other sandboxes only see fresh state once the L2 row is gone.
  revalidateTag(tag)
  await pgCacheInvalidate(tag)
  return NextResponse.json({ ok: true, revalidated: tag })
}
