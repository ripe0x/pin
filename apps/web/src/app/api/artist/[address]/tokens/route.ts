import { NextRequest, NextResponse } from "next/server"
import { discoverArtistTokens } from "@/lib/onchain-discovery"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params

  // Validate address format
  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return NextResponse.json(
      { error: "Invalid Ethereum address" },
      { status: 400 },
    )
  }

  try {
    const tokens = await discoverArtistTokens(address)

    return NextResponse.json(
      { address, tokens, count: tokens.length },
      {
        headers: {
          // Netlify CDN caches this at the edge — one function invocation per address per day.
          // Empty results aren't cached so they retry on next request.
          "Cache-Control": tokens.length > 0
            ? "public, max-age=86400, stale-while-revalidate=3600"
            : "no-store",
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
