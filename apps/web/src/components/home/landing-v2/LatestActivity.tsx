import Link from "next/link"
import { AddressZorb } from "@/components/AddressZorb"
import { OptimizedImage } from "@/components/OptimizedImage"
import { ActivityRow } from "@/components/home/v2/ActivityRow"
import { GroupedMintRow } from "@/components/home/v2/GroupedMintRow"
import { formatTimeAgo } from "@/components/home/v2/format"
import { getActivityFeed } from "@/lib/indexer-queries"
import { enrichFeedPage } from "@/lib/v2-activity"
import type { EnrichedActivityEvent, EnrichedFeedItem } from "@/lib/v2-activity-types"

const RAW_LIMIT = 30
const DISPLAY_LIMIT = 12
const LISTING_GROUP_MIN = 3
const LISTING_GROUP_MAX_GAP_SECONDS = 1800

type LandingFeedItem =
  | EnrichedFeedItem
  | { type: "listing-group"; events: EnrichedActivityEvent[] }

export async function LatestActivity() {
  const events = await getActivityFeed(RAW_LIMIT, null, 6_000).catch(() => null)
  if (events === null) {
    return (
      <section aria-labelledby="latest-activity" className="space-y-4">
        <ActivityHeading />
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            Latest indexed activity is temporarily unavailable. Collections,
            auctions, and artist records remain available.
          </p>
        </div>
      </section>
    )
  }

  const enriched = await enrichFeedPage(events)
  const items = groupListingRuns(enriched).slice(0, DISPLAY_LIMIT)

  return (
    <section aria-labelledby="latest-activity" className="space-y-4">
      <ActivityHeading />
      {items.length > 0 ? (
        <ul className="border-b border-gray-200">
          {items.map((item) =>
            item.type === "event" ? (
              <ActivityRow key={item.event.id} event={item.event} />
            ) : item.type === "group" ? (
              <GroupedMintRow key={item.id} group={item} />
            ) : (
              <ListingGroupRow key={item.events[0].id} events={item.events} />
            ),
          )}
        </ul>
      ) : (
        <p className="rounded-md border border-gray-200 p-5 text-sm text-fg-muted">
          No indexed activity yet.
        </p>
      )}
      <Link href="/?activity=all" className="inline-block text-xs font-mono underline underline-offset-4">
        View the full activity record
      </Link>
    </section>
  )
}

function ActivityHeading() {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          Historical evidence
        </p>
        <h2 id="latest-activity" className="mt-1 text-2xl font-semibold tracking-tight">
          Latest indexed activity
        </h2>
      </div>
      <p className="text-xs font-mono text-gray-500">Observed on Ethereum</p>
    </div>
  )
}

function groupListingRuns(items: EnrichedFeedItem[]): LandingFeedItem[] {
  const grouped: LandingFeedItem[] = []
  let i = 0
  while (i < items.length) {
    const current = items[i]
    if (current.type !== "event" || current.event.kind !== "auction.opened") {
      grouped.push(current)
      i += 1
      continue
    }

    const run = [current.event]
    let j = i + 1
    while (j < items.length) {
      const next = items[j]
      if (
        next.type !== "event" ||
        next.event.kind !== "auction.opened" ||
        next.event.artist.toLowerCase() !== current.event.artist.toLowerCase() ||
        run[run.length - 1].blockTime - next.event.blockTime >
          LISTING_GROUP_MAX_GAP_SECONDS
      ) {
        break
      }
      run.push(next.event)
      j += 1
    }

    if (run.length >= LISTING_GROUP_MIN) {
      grouped.push({ type: "listing-group", events: run })
    } else {
      grouped.push(...run.map((event) => ({ type: "event" as const, event })))
    }
    i = j
  }
  return grouped
}

function ListingGroupRow({ events }: { events: EnrichedActivityEvent[] }) {
  const newest = events[0]
  const withMedia = events.find((event) => event.mediaUrl)
  const artistHref = `/profile/${newest.artist}`

  return (
    <li className="border-t border-gray-200 px-1 py-4">
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="w-9 shrink-0 font-mono text-[11px] tabular-nums text-gray-500 sm:w-12 sm:text-xs">
          {formatTimeAgo(newest.blockTime)}
        </span>
        <div className="relative w-16 shrink-0 overflow-hidden">
          {withMedia?.mediaUrl ? (
            <OptimizedImage
              src={withMedia.mediaUrl}
              alt={withMedia.tokenTitle ?? "Recently listed work"}
              width={160}
              className="block h-auto w-full"
            />
          ) : newest.artistAvatarUrl ? (
            <OptimizedImage
              src={newest.artistAvatarUrl}
              alt=""
              width={120}
              className="aspect-square w-full object-cover"
            />
          ) : (
            <AddressZorb address={newest.artist} className="aspect-square w-full" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
            <Link href={artistHref} className="font-medium underline-offset-2 hover:underline">
              {newest.artistDisplayName}
            </Link>{" "}
            <span className="text-gray-600">listed {events.length} works</span>
          </p>
          <p className="mt-1 text-[11px] font-mono text-gray-500">
            One indexed listing run · individual prices remain on each work
          </p>
        </div>
      </div>
    </li>
  )
}
