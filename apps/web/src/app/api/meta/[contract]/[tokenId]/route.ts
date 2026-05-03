import { NextRequest, NextResponse } from "next/server"
import { ipfsToHttp } from "@pin/shared"
import { resolveTokenMetadataDirect } from "@/lib/onchain-discovery"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { isCrawlerUserAgent } from "@/lib/crawler"

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
  req: NextRequest,
  { params }: { params: Promise<{ contract: string; tokenId: string }> },
) {
  // This route is consumed by client-side JS (LazyAuctionCard) — not by
  // OG-image scrapers, which read the meta tag URL directly. Bots that
  // hit this JSON endpoint are scraping for an NFT database; they don't
  // need to be served. Skip the (potentially RPC-firing) cache miss
  // and return a quick 404. Real users go through the full path below.
  if (isCrawlerUserAgent(req.headers.get("user-agent"))) {
    return NextResponse.json(
      { metadata: null, mediaUri: null },
      {
        status: 404,
        headers: { "Cache-Control": "public, max-age=300" },
      },
    )
  }

  // Per-IP token bucket. Each successful request can fan out to a
  // tokenURI eth_call + IPFS fetch on cache miss; without this an
  // address-iterating bot can amplify into hundreds of RPC calls a
  // minute under a single IP.
  const ip = getClientIp(req)
  const rl = checkRateLimit("meta", ip, 60_000, 120)
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

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
