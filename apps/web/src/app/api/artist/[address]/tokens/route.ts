import { NextRequest, NextResponse } from "next/server"
import { getArtistGalleryPage } from "@/lib/artist-queries"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { isCrawlerUserAgent } from "@/lib/crawler"
import { withSingleFlight } from "@/lib/single-flight"

const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 100

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params

  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return NextResponse.json(
      { error: "Invalid Ethereum address" },
      { status: 400 },
    )
  }

  // Crawlers don't paginate JSON galleries — anything matching a known
  // bot UA is here to scrape. Reject cheap. Real users go through.
  if (isCrawlerUserAgent(req.headers.get("user-agent"))) {
    return NextResponse.json(
      { address, tokens: [], total: 0, page: 0, pageSize: 0, hasMore: false },
      { status: 200, headers: { "Cache-Control": "public, max-age=300" } },
    )
  }

  // Per-IP token bucket. Each successful request can fan out to 50+
  // RPC calls (token discovery + multicall buyPrice + metadata
  // enrichment). 30/min/IP keeps a single bot from generating
  // thousands of underlying RPC calls.
  const ip = getClientIp(req)
  const rl = checkRateLimit("artist-tokens", ip, 60_000, 30)
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  const url = req.nextUrl
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) | 0)
  const requestedSize = Number(url.searchParams.get("pageSize") ?? DEFAULT_PAGE_SIZE)
  const pageSize = Math.min(
    Math.max(1, Number.isFinite(requestedSize) ? requestedSize | 0 : DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  )

  try {
    // Single-flight: concurrent same-(address,page,pageSize) callers
    // serialize on a Postgres lock so a stampede collapses to one
    // expensive fetch + N-1 cache hits inside the wrapped function.
    const result = await withSingleFlight(
      `gallery-page:${address.toLowerCase()}:${page}:${pageSize}`,
      () => getArtistGalleryPage(address, page, pageSize),
    )

    return NextResponse.json(
      { address, ...result },
      {
        headers: {
          // Browser may cache short-term; CDN/edge must NOT cache because
          // Netlify's auto-generated cache key strips ?page and ?pageSize, so
          // paged URLs collide on a single edge entry. Server-side
          // unstable_cache (artist-cache.ts) covers the expensive work.
          "Cache-Control": "private, max-age=60",
        },
      },
    )
  } catch (err) {
    console.error("Artist token discovery failed:", err)
    return NextResponse.json(
      { error: "Failed to discover tokens" },
      { status: 500 },
    )
  }
}
