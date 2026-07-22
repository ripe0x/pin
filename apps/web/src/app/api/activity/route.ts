import { NextResponse } from "next/server"
import { unstable_cache } from "next/cache"
import {
  getActivityFeed,
  IndexerUnavailable,
  type ActivityCursor,
} from "@/lib/indexer-queries"
import {
  enrichFeedPage,
  serializeFeedItem,
  type SerializedFeedItem,
} from "@/lib/v2-activity"

/**
 * Lazy-scroll page endpoint for the v2 activity feed.
 *
 * Query params: `before` (blockTime, decimal seconds), `beforeId`
 * (the last event's `id` for keyset tiebreak), `limit` (1–100, default
 * 50). Without `before`/`beforeId` returns the first page.
 *
 * The endpoint resolves token metadata + artist identity server-side
 * before responding so the client renders without follow-up requests.
 * Both reads are point-lookups in steady state (token_metadata is
 * pre-warmed by `worker warm-metadata task`, ENS/EFP is pgCache + EFP HTTPS
 * with 24h TTL) — no per-request RPC fan-out.
 *
 * Caching: 30s revalidate keyed on `(limit, cursor)`. Matches the home
 * page's first-page cache window so the SSR'd page and any client-side
 * "load more" of the same first slice share a cache hit. Per-cursor
 * keying means each scroll page gets its own cache slot; historical
 * pages stay cached for the full window since on-chain history is
 * stable.
 */
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

// IMPORTANT: when `getActivityFeed` returns null (timeout / DB down /
// kill switch), throw rather than caching a `[]` result. `unstable_cache`
// doesn't persist rejections, so the next request retries fresh instead
// of serving an empty array for the full 30s revalidate window. The GET
// handler catches the throw and returns `{ events: [], unavailable: true }`
// so the client can keep its existing rows and retry on next scroll.
const fetchPaginatedFeed = unstable_cache(
  async (
    limit: number,
    cursor: ActivityCursor | null,
  ): Promise<{
    items: SerializedFeedItem[]
    nextCursor: { blockTime: number; id: string } | null
    rawCount: number
  }> => {
    const events = await getActivityFeed(limit, cursor)
    if (!events) throw new IndexerUnavailable()
    if (events.length === 0) return { items: [], nextCursor: null, rawCount: 0 }
    const items = await enrichFeedPage(events)
    const last = events[events.length - 1]
    // The cursor is the last RAW event: grouping collapses display rows,
    // but paging walks the underlying event stream. `rawCount` tells the
    // client whether the raw page was full (more may exist) — item count
    // can't, since a grouped page has fewer items than events.
    return {
      items: items.map(serializeFeedItem),
      nextCursor: { blockTime: last.blockTime, id: last.id },
      rawCount: events.length,
    }
  },
  ["activity-feed-page-v2"],
  { revalidate: 30, tags: ["activity-feed"] },
)

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url)
  const beforeRaw = url.searchParams.get("before")
  const beforeIdRaw = url.searchParams.get("beforeId")
  const limitRaw = url.searchParams.get("limit")

  let cursor: ActivityCursor | null = null
  if (beforeRaw && beforeIdRaw) {
    const blockTime = Number(beforeRaw)
    if (!Number.isFinite(blockTime) || blockTime < 0) {
      return NextResponse.json({ error: "invalid before" }, { status: 400 })
    }
    cursor = { blockTime, id: beforeIdRaw }
  }

  let limit = DEFAULT_LIMIT
  if (limitRaw) {
    const parsed = Number(limitRaw)
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(MAX_LIMIT, Math.floor(parsed))
    }
  }

  let page: {
    items: SerializedFeedItem[]
    nextCursor: { blockTime: number; id: string } | null
    rawCount: number
  }
  try {
    page = await fetchPaginatedFeed(limit, cursor)
  } catch {
    return NextResponse.json({
      items: [],
      nextCursor: null,
      rawCount: 0,
      unavailable: true,
    })
  }
  return NextResponse.json(page)
}
