import { NextRequest, NextResponse } from "next/server"
import { getArtistGalleryPage } from "@/lib/artist-queries"

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

  const url = req.nextUrl
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) | 0)
  const requestedSize = Number(url.searchParams.get("pageSize") ?? DEFAULT_PAGE_SIZE)
  const pageSize = Math.min(
    Math.max(1, Number.isFinite(requestedSize) ? requestedSize | 0 : DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  )

  try {
    const result = await getArtistGalleryPage(address, page, pageSize)

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
