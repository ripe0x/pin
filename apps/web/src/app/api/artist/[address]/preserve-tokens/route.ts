import { NextRequest, NextResponse } from "next/server"
import { discoverFoundationPinnedTokens } from "@/lib/onchain-discovery"
import { withRouteContext } from "@/lib/rpc-log"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params

  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return NextResponse.json(
      { error: "Invalid Ethereum address" },
      { status: 400 },
    )
  }

  try {
    const tokens = await withRouteContext(
      "/api/artist/[address]/preserve-tokens",
      () => discoverFoundationPinnedTokens(address),
    )

    return NextResponse.json(
      { address, tokens, count: tokens.length },
      {
        headers: {
          "Cache-Control":
            tokens.length > 0
              ? "public, max-age=86400, stale-while-revalidate=3600"
              : "no-store",
        },
      },
    )
  } catch (err) {
    console.error("Preserve token discovery failed:", err)
    return NextResponse.json(
      { error: "Failed to discover tokens" },
      { status: 500 },
    )
  }
}
