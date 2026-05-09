import { revalidateTag } from "next/cache"
import { NextRequest, NextResponse } from "next/server"
import { pgCacheInvalidate } from "@/lib/pg-cache"

/**
 * Flush the FundingWorksRipe lifetime-supporter cache that powers the
 * global footer block. The list is normally fetched once per 24h; hit
 * this endpoint after a new mint to surface the supporter immediately.
 *
 * Two access modes mirror `/api/revalidate`:
 *
 *  1. Authenticated (`secret` matches `REVALIDATE_SECRET`) — no rate
 *     limit. Use from CLI / automation.
 *
 *  2. Public (no secret) — rate-limited to 1 successful flush per IP
 *     per 60s. Returns 429 with `Retry-After` when over limit.
 *
 * Both layers (`unstable_cache` tag + Postgres `pgCache` prefix) get
 * cleared. Repopulation is lazy on the next footer render.
 */

const RATE_LIMIT_WINDOW_MS = 60_000

const recentFlushesByIp: Map<string, number> = (
  globalThis as unknown as {
    __pndSupportersRevalLimiter?: Map<string, number>
  }
).__pndSupportersRevalLimiter ??
  ((
    globalThis as unknown as {
      __pndSupportersRevalLimiter?: Map<string, number>
    }
  ).__pndSupportersRevalLimiter = new Map())

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return req.headers.get("x-real-ip") ?? "unknown"
}

function checkRateLimit(
  ip: string,
): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()
  if (recentFlushesByIp.size > 1000) {
    for (const [k, t] of recentFlushesByIp) {
      if (now - t > RATE_LIMIT_WINDOW_MS) recentFlushesByIp.delete(k)
    }
  }
  const last = recentFlushesByIp.get(ip)
  if (last && now - last < RATE_LIMIT_WINDOW_MS) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - last)) / 1000)
    return { ok: false, retryAfter }
  }
  recentFlushesByIp.set(ip, now)
  return { ok: true }
}

async function flush() {
  revalidateTag("fwr-supporters")
  await pgCacheInvalidate("fwr-supporters:")
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret")
  const expected = process.env.REVALIDATE_SECRET

  if (secret) {
    if (!expected) {
      return NextResponse.json(
        { ok: false, error: "REVALIDATE_SECRET env var not set on server" },
        { status: 500 },
      )
    }
    if (secret !== expected) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      )
    }
  } else {
    const ip = getClientIp(req)
    const limit = checkRateLimit(ip)
    if (!limit.ok) {
      return NextResponse.json(
        { ok: false, error: "rate-limited", retryAfter: limit.retryAfter },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfter) },
        },
      )
    }
  }

  await flush()

  return NextResponse.json({
    ok: true,
    revalidated: ["fwr-supporters"],
    pgCacheCleared: ["fwr-supporters:"],
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
