import { NextResponse } from "next/server"
import { revalidateTag } from "next/cache"

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
  revalidateTag("catalog")
  return NextResponse.json({ ok: true })
}
