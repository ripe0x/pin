import { unstable_cache } from "next/cache"
import { getActivityFeed, IndexerUnavailable } from "@/lib/indexer-queries"
import {
  deserializeFromWire,
  enrichActivityEvents,
  serializeForWire,
  type SerializedActivityEvent,
} from "@/lib/v2-activity"
import { ActivityFeedClient } from "./ActivityFeedClient"

const FEED_SIZE = 50

/**
 * Cached enrichment pipeline for the SSR'd first page. The unioned
 * indexer query plus 50-row token + ENS enrichment costs ~600–1000ms on
 * a warm path; without caching, every home-page visit pays that wait
 * (the Suspense fallback shows "loading activity…" for the duration).
 *
 * Cache TTL is 30s — Ponder's head-following polls every 60s, so 30s of
 * staleness is below the upstream's natural lag and keeps repeat visits
 * effectively instant. New auctions/bids appear within ~30s after they
 * settle into Ponder. The `activity-feed` tag lets us flush on demand
 * via `revalidateTag` if that ever becomes desirable.
 *
 * Cache stores the wire-serialized form (bigints → decimal strings)
 * because `unstable_cache` JSON-encodes its values internally and
 * throws on raw bigints. We re-hydrate on read so callers still get the
 * native bigint shape.
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
    events: SerializedActivityEvent[]
    hasMore: boolean
  }> => {
    const events = await getActivityFeed(
      FEED_SIZE,
      null,
      HOME_FEED_TIMEOUT_MS,
    )
    if (!events) throw new IndexerUnavailable()
    if (events.length === 0) return { events: [], hasMore: false }
    const enriched = await enrichActivityEvents(events)
    return {
      events: enriched.map(serializeForWire),
      hasMore: enriched.length >= FEED_SIZE,
    }
  },
  ["activity-feed-initial-v1"],
  { revalidate: 30, tags: ["activity-feed"] },
)

/**
 * Server-rendered first page of the activity feed.
 *
 * Pulls the unioned event stream from the indexer, resolves token
 * metadata + artist identity (Postgres point-lookups thanks to the
 * metadata warmer + EFP/ENS cache), and hands the enriched first page
 * to a client component for infinite-scroll continuation.
 *
 * If the indexer is unavailable / disabled we render an empty state
 * rather than the rest of the page disappearing.
 */
export async function ActivityFeed() {
  let result: { events: SerializedActivityEvent[]; hasMore: boolean }
  try {
    result = await getInitialFeedPage()
  } catch {
    return (
      <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
        feed temporarily unavailable
      </p>
    )
  }

  if (result.events.length === 0) {
    return (
      <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
        no activity yet
      </p>
    )
  }

  return (
    <ActivityFeedClient
      initial={result.events.map(deserializeFromWire)}
      hasMore={result.hasMore}
    />
  )
}
