import { revalidateTag } from "next/cache"
import { NextRequest, NextResponse } from "next/server"

/**
 * Manually flush the artist gallery + enriched-page caches. Hit this after
 * minting a new token so the gallery picks it up immediately instead of
 * waiting for the 24h TTL.
 *
 * Two access modes:
 *
 *  1. Authenticated (secret matches `REVALIDATE_SECRET` env var) — no rate
 *     limit. Use this from CLI/automation:
 *
 *       curl 'https://pnd.ripe.wtf/api/revalidate?secret=$REVALIDATE_SECRET'
 *
 *  2. Public (no secret) — rate-limited to 1 successful flush per IP per
 *     60 s. Used by the in-page Refresh pill so artists can flush without
 *     a shared secret. Returns 429 with `Retry-After` when over limit.
 *
 * Both `artist-refs` and `artist-enriched` are global tags — flushing
 * invalidates the caches for ALL artists, not just one. The optional
 * `artist` query param is informational (echoed in the response).
 * Repopulation is lazy (one cold gallery read per artist) so the cost
 * stays bounded under the rate limit.
 */

const RATE_LIMIT_WINDOW_MS = 60_000

// Persist across HMR reloads in dev. On Vercel each lambda instance has its
// own copy, which is fine for a casual rate limit — the worst case is a
// scripted attacker rotating instances, and the cost (one cache miss) is
// already bounded.
const recentFlushesByIp: Map<string, number> = (
  globalThis as unknown as { __pndRefreshLimiter?: Map<string, number> }
).__pndRefreshLimiter ??
  ((
    globalThis as unknown as { __pndRefreshLimiter?: Map<string, number> }
  ).__pndRefreshLimiter = new Map())

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return req.headers.get("x-real-ip") ?? "unknown"
}

function checkRateLimit(
  ip: string,
): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()

  // Opportunistic cleanup — keep the map small without scheduling a timer.
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

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret")
  const expected = process.env.REVALIDATE_SECRET
  const artist = req.nextUrl.searchParams.get("artist")

  // Authenticated path: skips the rate limit entirely.
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
    // Public path: rate-limit by IP.
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

  revalidateTag("artist-refs")
  revalidateTag("artist-enriched")

  return NextResponse.json({
    ok: true,
    revalidated: ["artist-refs", "artist-enriched"],
    requested_for: artist ?? null,
    note: "All-artist flush; per-artist tagging requires dynamic tags (not supported by unstable_cache).",
  })
}
