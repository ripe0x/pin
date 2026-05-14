import { NextRequest, NextResponse } from "next/server"
import { unstable_cache } from "next/cache"
import type { Address } from "viem"
import { pgCache } from "@/lib/pg-cache"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { getCatalog, type Catalog } from "@/lib/catalog"

/**
 * Read an artist's declared record from the on-chain
 * Catalog. Returns the contracts/tokens/ranges declared
 * by the address.
 *
 * Two-layer cache (5 min L1 unstable_cache + L2 pgCache) per address.
 * The underlying registry view functions are cheap point lookups, but
 * caching the assembled payload keeps repeated dependency-report and
 * /record visits free of RPC.
 *
 * Per-IP rate limit at 10 req/min mirrors the dependency-check route.
 */

type SerializedRecord = Omit<Catalog, "artist"> & {
  artist: string
}

const RECORD_TTL_S = 5 * 60

const cached = unstable_cache(
  (addressLower: string): Promise<SerializedRecord> =>
    pgCache<SerializedRecord>(
      `catalog:${addressLower}`,
      RECORD_TTL_S,
      async () => {
        const r = await getCatalog(addressLower as Address)
        return {
          artist: r.artist,
          contracts: r.contracts,
          tokens: r.tokens,
          tokenRanges: r.tokenRanges,
        }
      },
    ),
  ["catalog-v1"],
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
