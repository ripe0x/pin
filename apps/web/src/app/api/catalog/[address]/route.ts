import { NextRequest, NextResponse } from "next/server"
import { unstable_cache } from "next/cache"
import type { Address } from "viem"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { getCatalog, type Catalog } from "@/lib/catalog"

/**
 * Read an artist's declared record from the on-chain
 * Catalog. Returns the contracts/tokens/ranges declared
 * by the address.
 *
 * Backed by Ponder (Postgres reads against catalog_*) with a viem
 * multicall fallback — see `apps/web/src/lib/catalog.ts`. The old
 * two-layer cache (unstable_cache + pgCache) collapsed to a single
 * `unstable_cache` layer once the indexer landed: Postgres itself is
 * the cache, so wrapping it again with pgCache was redundant.
 *
 * Per-IP rate limit at 10 req/min mirrors the dependency-check route.
 */

type SerializedRecord = Omit<Catalog, "artist"> & {
  artist: string
}

const RECORD_TTL_S = 60

const cached = unstable_cache(
  async (addressLower: string): Promise<SerializedRecord> => {
    const r = await getCatalog(addressLower as Address)
    return {
      artist: r.artist,
      contracts: r.contracts,
      tokens: r.tokens,
      tokenRanges: r.tokenRanges,
    }
  },
  ["catalog-route-v2"],
  { revalidate: RECORD_TTL_S, tags: ["catalog"] },
)

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse<SerializedRecord | { error: string }>> {
  const { address } = await ctx.params

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }

  const ip = getClientIp(req)
  const rl = checkRateLimit("catalog", ip, 60_000, 10)
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  try {
    const data = await cached(address.toLowerCase())
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, max-age=60" },
    })
  } catch (err) {
    console.error("record read failed:", err)
    return NextResponse.json({ error: "read failed" }, { status: 500 })
  }
}
