import { NextRequest, NextResponse } from "next/server"
import { getOwnedErc721Page } from "@/lib/alchemy"
import { pgCache } from "@/lib/pg-cache"

/**
 * Page through ERC-721s currently owned by `wallet`. Cursor-based — clients
 * pass back the `nextPageKey` from the prior response to fetch the next page.
 *
 * Cached per (wallet, pageKey) for 5 minutes via pgCache. Ownership changes
 * happen on-chain in real time but a 5-min lag on a picker UI is fine, and
 * the cache is what protects Alchemy CU budget when many users share a
 * wallet view (or one user clicks back-forward repeatedly).
 */
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

  const pageKey = req.nextUrl.searchParams.get("pageKey") ?? ""
  const cacheKey = `owned-erc721:${address.toLowerCase()}:${pageKey}`

  try {
    const result = await pgCache(cacheKey, 5 * 60, () =>
      getOwnedErc721Page(address, pageKey || undefined),
    )

    return NextResponse.json(
      { address, ...result },
      {
        headers: {
          // Browser cache is short — clicking back to /auction/new shouldn't
          // re-fetch instantly, but ownership state can change so don't hold
          // it long. CDN must NOT cache because the cursor query-string is
          // wallet-specific.
          "Cache-Control": "private, max-age=60",
        },
      },
    )
  } catch (err) {
    console.error("Owned NFTs lookup failed:", err)
    return NextResponse.json(
      { error: "Failed to fetch owned tokens" },
      { status: 500 },
    )
  }
}
