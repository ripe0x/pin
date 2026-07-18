import { NextRequest, NextResponse } from "next/server"
import { resolveMintCollection } from "@/lib/mint-collections"
import { getCollectionTokens, type GalleryToken } from "@/lib/mint-onchain"

/**
 * Thumbnails for every minted token in a collection — backs the gallery toggle
 * on the collection page. Fetched on-demand so a collection-page view that
 * never opens the gallery makes zero token-art reads. Cached upstream in
 * `getCollectionTokens` (pgCache), with a short browser cache here.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ contract: string }> },
): Promise<NextResponse<{ tokens: GalleryToken[] } | { error: string }>> {
  const { contract } = await ctx.params
  const desc = resolveMintCollection(contract)
  if (!desc) return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  try {
    const tokens = await getCollectionTokens(desc)
    return NextResponse.json({ tokens }, { headers: { "Cache-Control": "private, max-age=30" } })
  } catch {
    return NextResponse.json({ error: "gallery lookup failed" }, { status: 500 })
  }
}
