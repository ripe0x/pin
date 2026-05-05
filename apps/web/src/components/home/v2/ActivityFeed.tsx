import { unstable_noStore as noStore } from "next/cache"
import { getActivityFeed } from "@/lib/indexer-queries"
import { enrichActivityEvents } from "@/lib/v2-activity"
import { ActivityFeedClient } from "./ActivityFeedClient"

const FEED_SIZE = 50

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
  noStore()

  const events = await getActivityFeed(FEED_SIZE)

  if (!events) {
    return (
      <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
        feed temporarily unavailable
      </p>
    )
  }

  if (events.length === 0) {
    return (
      <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
        no activity yet
      </p>
    )
  }

  const enriched = await enrichActivityEvents(events)

  return (
    <ActivityFeedClient
      initial={enriched}
      hasMore={enriched.length >= FEED_SIZE}
    />
  )
}
