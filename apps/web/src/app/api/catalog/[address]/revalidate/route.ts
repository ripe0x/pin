import { NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { pgCacheInvalidate } from "@/lib/pg-cache"

/**
 * Bust the record-cache for a specific artist after a write tx confirms.
 * Called by `useCatalogWrite` once `isSuccess` flips true.
 *
 * Two layers to clear:
 *   1. `unstable_cache` — invalidated by tag.
 *   2. `pgCache` — invalidated by key prefix.
 *
 * Same pattern as `/api/auction/revalidate`. Safe to call unauthenticated:
 * worst case a stranger forces a re-fetch of public data, which is what
 * the route already does on cache miss. No write surface, no rate limit
 * worth tightening here because the cost is bounded by the registry
 * read itself.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse<{ ok: true } | { error: string }>> {
  const { address } = await ctx.params
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }
  const lower = address.toLowerCase()
  await pgCacheInvalidate(`catalog:${lower}`)
  revalidateTag("catalog")
  return NextResponse.json({ ok: true })
}
