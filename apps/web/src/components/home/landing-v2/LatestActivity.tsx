import { unstable_cache } from "next/cache"
import Link from "next/link"
import { ActivityRow } from "@/components/home/v2/ActivityRow"
import {
  BidGroupRow,
  ListingGroupRow,
} from "@/components/home/v2/GroupedActivityRows"
import { GroupedMintRow } from "@/components/home/v2/GroupedMintRow"
import { groupSecondaryFeedItems } from "@/lib/activity-secondary-grouping"
import { getActivityFeed, IndexerUnavailable } from "@/lib/indexer-queries"
import {
  deserializeFeedItem,
  enrichFeedPage,
  serializeFeedItem,
  type SerializedFeedItem,
} from "@/lib/v2-activity"

const RAW_LIMIT = 30
const DISPLAY_LIMIT = 12

// Query plus enrichment cached for 30s across requests, keyed apart from
// the full feed's cache. A null feed throws so the miss is not cached and
// the next request retries.
const getPndFeedPage = unstable_cache(
  async (): Promise<SerializedFeedItem[]> => {
    const events = await getActivityFeed(RAW_LIMIT, null, 6_000, "pnd")
    if (!events) throw new IndexerUnavailable()
    const items = await enrichFeedPage(events)
    return items.map(serializeFeedItem)
  },
  ["activity-feed-landing-pnd-v1"],
  { revalidate: 30, tags: ["activity-feed"] },
)

export async function LatestActivity() {
  // The feed is scoped to PND's own contracts (auction houses and Surface
  // collections). The full record stays at /activity.
  const page = await getPndFeedPage().catch(() => null)
  if (page === null) {
    return (
      <section aria-labelledby="latest-activity" className="min-w-0 space-y-4">
        <ActivityHeading />
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            Latest activity is temporarily unavailable. Collections,
            auctions, and artist records remain available.
          </p>
        </div>
      </section>
    )
  }

  const enriched = page.map(deserializeFeedItem)
  const items = groupSecondaryFeedItems(enriched).slice(0, DISPLAY_LIMIT)

  return (
    <section aria-labelledby="latest-activity" className="min-w-0 space-y-4">
      <ActivityHeading />
      {items.length > 0 ? (
        <ul className="border-b border-gray-200">
          {items.map((item) =>
            item.type === "event" ? (
              <ActivityRow key={item.event.id} event={item.event} />
            ) : item.type === "group" ? (
              <GroupedMintRow key={item.id} group={item} />
            ) : item.type === "bid-group" ? (
              <BidGroupRow key={item.key} group={item} />
            ) : (
              <ListingGroupRow key={item.key} group={item} />
            ),
          )}
        </ul>
      ) : (
        <p className="rounded-md border border-gray-200 p-5 text-sm text-fg-muted">
          No activity yet.
        </p>
      )}
      <Link href="/activity" className="inline-block text-xs font-mono underline underline-offset-4">
        View the full activity record
      </Link>
    </section>
  )
}

function ActivityHeading() {
  return (
    <div>
      <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
        Historical evidence
      </p>
      <h2 id="latest-activity" className="mt-1 text-2xl font-semibold tracking-tight">
        Latest activity
      </h2>
    </div>
  )
}
