import { NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { rateLimit } from "@/lib/rate-limit"

/**
 * Bust the record-cache for a specific artist after a write tx confirms.
 * Called by `useCatalogWrite` once `isSuccess` flips true.
 *
 * Only one layer to clear now — `unstable_cache`, invalidated by tag.
 * The previous pgCache wrap is gone now that the underlying reads come
 * straight from Ponder's Postgres tables (see lib/catalog.ts).
 *
 * Caveat: this kicks the request cache, not the indexer. Ponder polls
 * mainnet HEAD every 300s, so a write that confirms now may not appear
 * in the next render. The address param is preserved in the URL even
 * though we revalidate the whole `catalog` tag — kept so a future per-
 * artist invalidation strategy can slot in without breaking callers.
 *
 * Same pattern as `/api/auction/revalidate`. Unauthenticated: worst case a
 * stranger forces a re-fetch of public data, which is what the route
 * already does on cache miss. The tag is global, so a shared per-IP rate
 * limit keeps one client from holding every catalog cold.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse<{ ok: true } | { error: string; retryAfter?: number }>> {
  const rl = await rateLimit(req, { namespace: "catalog-revalidate", windowMs: 60_000, max: 20 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }
  const { address } = await ctx.params
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }
  revalidateTag("catalog")
  return NextResponse.json({ ok: true })
}
