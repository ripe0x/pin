import { unstable_cache } from "next/cache"
import { getActivityFeed, IndexerUnavailable } from "@/lib/indexer-queries"
import {
  deserializeFeedItem,
  enrichFeedPage,
  serializeFeedItem,
  type SerializedFeedItem,
} from "@/lib/v2-activity"
import { ActivityFeedClient } from "./ActivityFeedClient"

const FEED_SIZE = 50

/**
 * Cached enrichment pipeline for the SSR'd first page. The unioned
 * indexer query plus enrichment costs ~600–1000ms on a warm path;
 * without caching, every home-page visit pays that wait (the Suspense
 * fallback shows "loading activity…" for the duration).
 *
 * Cache TTL is 30s — Ponder's head-following polls every 60s, so 30s of
 * staleness is below the upstream's natural lag and keeps repeat visits
 * effectively instant. New events appear within ~30s after they settle
 * into Ponder; a live mint run keeps folding into its group row on each
 * revalidation. The `activity-feed` tag lets us flush on demand via
 * `revalidateTag` if that ever becomes desirable.
 *
 * The cache stores wire-serialized feed items (bigints → decimal
 * strings) because `unstable_cache` JSON-encodes its values internally
 * and throws on raw bigints. Callers re-hydrate on read.
 *
 * The pagination cursor is the last RAW event of the fetched page —
 * grouping collapses rows for display but paging walks the underlying
 * event stream, so nothing is skipped at a page boundary.
 */
// 6s budget on the home read because it's behind <Suspense>; a slow
// cold render is acceptable, a 30s window of empty SSRs is not.
const HOME_FEED_TIMEOUT_MS = 6_000

// IMPORTANT: when `getActivityFeed` returns null (timeout / DB down /
// kill switch), throw rather than caching a null/empty result.
// `unstable_cache` doesn't persist rejections, so the next request
// retries fresh against the indexer instead of serving the bad value
// for the full 30s revalidate window.
const getInitialFeedPage = unstable_cache(
  async (): Promise<{
    items: SerializedFeedItem[]
    nextCursor: { blockTime: number; id: string } | null
    hasMore: boolean
  }> => {
    const events = await getActivityFeed(
      FEED_SIZE,
      null,
      HOME_FEED_TIMEOUT_MS,
    )
    if (!events) throw new IndexerUnavailable()
    if (events.length === 0) {
      return { items: [], nextCursor: null, hasMore: false }
    }
    const items = await enrichFeedPage(events)
    const last = events[events.length - 1]
    return {
      items: items.map(serializeFeedItem),
      nextCursor: { blockTime: last.blockTime, id: last.id },
      hasMore: events.length >= FEED_SIZE,
    }
  },
  ["activity-feed-initial-v2"],
  { revalidate: 30, tags: ["activity-feed"] },
)

/**
 * Server-rendered first page of the activity feed.
 *
 * Pulls the unioned event stream from the indexer, collapses mint runs,
 * resolves metadata + identity (Postgres point-lookups thanks to the
 * metadata warmer + EFP/ENS cache), and hands the enriched first page
 * to a client component for infinite-scroll continuation.
 *
 * If the indexer is unavailable / disabled we render an empty state
 * rather than the rest of the page disappearing.
 */
export async function ActivityFeed() {
  let result: {
    items: SerializedFeedItem[]
    nextCursor: { blockTime: number; id: string } | null
    hasMore: boolean
  }
  try {
    result = await getInitialFeedPage()
  } catch {
    return (
      <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
        feed temporarily unavailable
      </p>
    )
  }

  if (result.items.length === 0) {
    return (
      <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
        no activity yet
      </p>
    )
  }

  return (
    <ActivityFeedClient
      initial={result.items.map(deserializeFeedItem)}
      initialCursor={result.nextCursor}
      hasMore={result.hasMore}
    />
  )
}
