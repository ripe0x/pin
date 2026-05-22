/**
 * On-demand metadata revalidation.
 *
 * Token metadata is cached for 24h (see `lib/metadata.ts`) because it rarely
 * changes — but it's not strictly immutable (reveal collections, corrected
 * metadata, swapped media). This endpoint lets the site owner force a refresh
 * without waiting for the cache to expire:
 *
 *   # Refresh ONE token
 *   curl -X POST "https://yoursite.com/api/revalidate?token=0xCONTRACT:TOKENID" \
 *     -H "x-revalidate-secret: $REVALIDATE_SECRET"
 *
 *   # Refresh EVERY token on the site
 *   curl -X POST "https://yoursite.com/api/revalidate" \
 *     -H "x-revalidate-secret: $REVALIDATE_SECRET"
 *
 * The secret may also be passed as `?secret=…`. Protect this with a real
 * secret: an open trigger could be spammed to hammer the RPC / IPFS gateways.
 * If `REVALIDATE_SECRET` is unset the endpoint refuses all requests.
 */
import { NextResponse } from "next/server"
import { revalidatePath, revalidateTag } from "next/cache"
import { isAddress } from "viem"
import { TOKEN_METADATA_TAG, tokenMetadataTag } from "@/lib/metadata"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "REVALIDATE_SECRET is not set. Add it to your hosting env to enable this endpoint.",
      },
      { status: 503 },
    )
  }

  const url = new URL(request.url)
  const provided =
    request.headers.get("x-revalidate-secret") ?? url.searchParams.get("secret")
  if (provided !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const token = url.searchParams.get("token")
  if (token) {
    const [contract, tokenId] = token.split(/[:/]/)
    if (!contract || !isAddress(contract) || !tokenId) {
      return NextResponse.json(
        {
          ok: false,
          error: "token must be '<contract>:<tokenId>', e.g. 0xabc…:42",
        },
        { status: 400 },
      )
    }
    revalidateTag(tokenMetadataTag(contract, tokenId))
    // Re-render pages so the refreshed metadata shows promptly. Only the
    // invalidated token re-fetches; other tokens' cache entries stay warm.
    revalidatePath("/", "layout")
    return NextResponse.json({
      ok: true,
      revalidated: `${contract.toLowerCase()}:${tokenId}`,
    })
  }

  revalidateTag(TOKEN_METADATA_TAG)
  revalidatePath("/", "layout")
  return NextResponse.json({ ok: true, revalidated: "all-token-metadata" })
}
