import type {
  EnrichedActivityEvent,
  EnrichedFeedItem,
} from "./v2-activity-types"

export type EnrichedListingGroup = {
  type: "listing-group"
  key: string
  events: EnrichedActivityEvent[]
}

export type EnrichedBidGroup = {
  type: "bid-group"
  key: string
  events: EnrichedActivityEvent[]
}

export type DisplayFeedItem =
  | EnrichedFeedItem
  | EnrichedListingGroup
  | EnrichedBidGroup

type SecondaryKind = "listing" | "bid"
type Bucket = {
  kind: SecondaryKind
  key: string
  events: EnrichedActivityEvent[]
}

function groupKey(event: EnrichedActivityEvent): {
  kind: SecondaryKind
  key: string
} | null {
  if (event.kind === "auction.opened") {
    // UTC day is deterministic across server, browser, and preview regions.
    const day = Math.floor(event.blockTime / 86_400)
    return {
      kind: "listing",
      key: `listing:${event.artist.toLowerCase()}:${day}`,
    }
  }
  if (
    (event.kind === "auction.firstBid" || event.kind === "auction.bid") &&
    event.auctionKey
  ) {
    return { kind: "bid", key: `bid:${event.auctionKey.toLowerCase()}` }
  }
  return null
}

/**
 * Collapse page-window listing and bid noise without reordering unrelated
 * activity. A bucket is emitted at its newest event's position and later
 * members disappear. Two events are enough to communicate the aggregate.
 */
export function groupSecondaryFeedItems(
  items: EnrichedFeedItem[],
): DisplayFeedItem[] {
  const buckets = new Map<string, Bucket>()
  const bucketByEvent = new Map<EnrichedActivityEvent, Bucket>()

  for (const item of items) {
    if (item.type !== "event") continue
    const grouped = groupKey(item.event)
    if (!grouped) continue
    let bucket = buckets.get(grouped.key)
    if (!bucket) {
      bucket = { ...grouped, events: [] }
      buckets.set(grouped.key, bucket)
    }
    bucket.events.push(item.event)
    bucketByEvent.set(item.event, bucket)
  }

  const emitted = new Set<Bucket>()
  const output: DisplayFeedItem[] = []
  for (const item of items) {
    if (item.type !== "event") {
      output.push(item)
      continue
    }
    const bucket = bucketByEvent.get(item.event)
    if (!bucket || bucket.events.length < 2) {
      output.push(item)
      continue
    }
    if (emitted.has(bucket)) continue
    emitted.add(bucket)
    output.push({
      type: bucket.kind === "listing" ? "listing-group" : "bid-group",
      key: bucket.key,
      events: bucket.events,
    })
  }
  return output
}
