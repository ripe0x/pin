import { NextRequest, NextResponse } from "next/server"
import { getCollectedPage } from "@/lib/profile-reads"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { isCrawlerUserAgent } from "@/lib/crawler"
import { clampHoldingsLimit, DEFAULT_HOLDINGS_LIMIT } from "@/lib/collector-holdings"

/**
 * GET /api/collector/:address/holdings?cursor=&limit=
 *
 * A wallet's current holdings among the works PND indexes (#296):
 * ERC-721 owners and ERC-1155 balances, newest first, keyset paginated.
 * Pure Postgres (lib/reads.ts getCollectorTokens): no ownerOf, getLogs or
 * wallet-NFT API call, so a request can't amplify into chain spend. Still
 * rate-limited per IP, since every page is a few index scans.
 *
 * Response: { address, items, total, nextCursor, coverage }. `nextCursor`
 * is opaque; pass it back as `cursor`. An unknown cursor starts from the
 * first page. `coverage` is "pnd-indexed-works": holdings outside what
 * PND indexes are not listed. Each item is a `CollectedCard`
 * (lib/profile-collected.ts): the holding plus title, artwork and the
 * attributed artist, all from Postgres, so the profile's Collected tab
 * (#299) pages through this route with no second request per page.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid Ethereum address" }, { status: 400 })
  }

  if (isCrawlerUserAgent(req.headers.get("user-agent"))) {
    return NextResponse.json(
      { address, items: [], total: 0, nextCursor: null, coverage: "pnd-indexed-works" },
      { status: 200, headers: { "Cache-Control": "public, max-age=300" } },
    )
  }

  const rl = checkRateLimit("collector-holdings", getClientIp(req), 60_000, 30)
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  const url = req.nextUrl
  const limit = clampHoldingsLimit(url.searchParams.get("limit") ?? DEFAULT_HOLDINGS_LIMIT)
  const cursor = url.searchParams.get("cursor")
  // `?exclude=own` leaves out the wallet's own created works (the
  // profile's Collected tab). Keep it the same across a cursor walk.
  const excludeOwnWorks = url.searchParams.get("exclude") === "own"

  try {
    const page = await getCollectedPage(address, { cursor, limit, excludeOwnWorks })
    return NextResponse.json(
      {
        address: address.toLowerCase(),
        items: page.items,
        total: page.total,
        nextCursor: page.nextCursor,
        coverage: page.coverage,
      },
      {
        // Private: Netlify's edge cache key drops the query string, so
        // paged URLs would collide on one shared entry.
        headers: { "Cache-Control": "private, max-age=60" },
      },
    )
  } catch (err) {
    console.error("Collector holdings read failed:", err)
    return NextResponse.json({ error: "Failed to read holdings" }, { status: 500 })
  }
}
