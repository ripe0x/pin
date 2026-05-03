import { NextRequest, NextResponse } from "next/server"
import { ipfsToHttp } from "@pin/shared"
import { resolveTokenMetadataDirect } from "@/lib/onchain-discovery"

/**
 * OG-metadata endpoint for social embeds (Discord cards, Twitter previews,
 * iMessage). Public, hit by the entire internet whenever someone shares a
 * token URL.
 *
 * Previously this route created its own viem client referencing
 * `ALCHEMY_MAINNET_URL` and read `tokenURI` uncached on every
 * call. That made it (a) bypass the `/api/rpc` proxy's rate limit and (b)
 * pay a fresh on-chain read per (contract, tokenId, CDN-edge) — i.e. anyone
 * iterating token IDs got a free RPC channel.
 *
 * Now: delegate to `resolveTokenMetadataDirect`, which is wrapped in
 * `unstable_cache(..., 1h)` and (after the Postgres shared-cache layer
 * lands) gets a second cache tier across all sandbox instances. Successful
 * responses keep their 1-year HTTP cache header so repeat embeds never even
 * reach the function.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ contract: string; tokenId: string }> },
) {
  const { contract, tokenId } = await params

  try {
    const metadata = await resolveTokenMetadataDirect(contract, tokenId)

    if (!metadata) {
      return NextResponse.json(
        { metadata: null, mediaUri: null },
        {
          status: 404,
          // Short edge cache + SWR so a token whose metadata is published
          // later (IPFS pin, contract upgrade) surfaces within a minute.
          headers: {
            "Cache-Control":
              "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
          },
        },
      )
    }

    const mediaUri = metadata.image ? ipfsToHttp(metadata.image) : null

    return NextResponse.json(
      { metadata, mediaUri },
      {
        // Token metadata is essentially immutable (IPFS-hashed). Browsers
        // keep it for a year. CDN caches for a day with a week of SWR so
        // an actual mutation eventually surfaces without a manual purge.
        // `s-maxage` is explicit because some CDNs (Netlify) ignore plain
        // `max-age` for shared caching.
        headers: {
          "Cache-Control":
            "public, max-age=31536000, s-maxage=86400, stale-while-revalidate=604800",
        },
      },
    )
  } catch {
    return NextResponse.json(
      { metadata: null, mediaUri: null },
      {
        status: 500,
        headers: {
          "Cache-Control":
            "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
        },
      },
    )
  }
}
