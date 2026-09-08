import Link from "next/link"
import { AddressZorb } from "@/components/AddressZorb"
import { OptimizedImage } from "@/components/OptimizedImage"
import type {
  EnrichedBidGroup,
  EnrichedListingGroup,
} from "@/lib/activity-secondary-grouping"
import { formatEth, formatSpan, formatTimeAgo } from "./format"

function GroupMedia({
  events,
  fallbackAddress,
}: {
  events: EnrichedListingGroup["events"]
  fallbackAddress: string
}) {
  const event = events.find((candidate) => candidate.mediaUrl)
  if (!event?.mediaUrl) {
    const avatar = events[0].artistAvatarUrl
    return avatar ? (
      <OptimizedImage
        src={avatar}
        alt=""
        width={120}
        className="aspect-square w-full object-cover"
      />
    ) : (
      <AddressZorb address={fallbackAddress} className="aspect-square w-full" />
    )
  }
  return event.isVideo ? (
    <video
      src={event.mediaUrl}
      muted
      playsInline
      preload="metadata"
      className="block h-auto w-full"
    />
  ) : (
    <OptimizedImage
      src={event.mediaUrl}
      alt={event.tokenTitle ?? "Activity artwork"}
      width={160}
      className="block h-auto w-full"
    />
  )
}

export function ListingGroupRow({ group }: { group: EnrichedListingGroup }) {
  const newest = group.events[0]
  return (
    <li className="border-t border-gray-200 px-1 py-4">
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="w-9 shrink-0 font-mono text-[11px] tabular-nums text-gray-500 sm:w-12 sm:text-xs">
          {formatTimeAgo(newest.blockTime)}
        </span>
        <div className="relative w-16 shrink-0 overflow-hidden">
          <GroupMedia events={group.events} fallbackAddress={newest.artist} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
            <Link
              href={`/profile/${newest.artist}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {newest.artistDisplayName}
            </Link>{" "}
            <span className="text-gray-600">
              listed {group.events.length} works
            </span>
          </p>
          <p className="mt-1 text-[11px] font-mono text-gray-500">
            One listing batch. Individual prices remain on each work.
          </p>
        </div>
      </div>
    </li>
  )
}

export function BidGroupRow({ group }: { group: EnrichedBidGroup }) {
  const newest = group.events[0]
  const oldest = group.events[group.events.length - 1]
  const tokenHref =
    newest.tokenContract && newest.tokenId
      ? newest.collection
        ? `/collections/${newest.collection}/${newest.tokenId}`
        : `/${newest.tokenContract}/${newest.tokenId}`
      : null
  return (
    <li className="border-t border-gray-200 px-1 py-4">
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="w-9 shrink-0 font-mono text-[11px] tabular-nums text-gray-500 sm:w-12 sm:text-xs">
          {formatTimeAgo(newest.blockTime)}
        </span>
        <div className="relative w-16 shrink-0 overflow-hidden">
          <GroupMedia events={group.events} fallbackAddress={newest.artist} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
            <span className="font-medium">{group.events.length} bids</span>
            <span className="text-gray-600"> on </span>
            {tokenHref ? (
              <Link href={tokenHref} className="underline-offset-2 hover:underline">
                {newest.tokenTitle ?? "a work"}
              </Link>
            ) : (
              <span>{newest.tokenTitle ?? "a work"}</span>
            )}
            <span className="text-gray-600"> by </span>
            <Link
              href={`/profile/${newest.artist}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {newest.artistDisplayName}
            </Link>
          </p>
          <p className="mt-1 text-[11px] font-mono text-gray-500">
            {newest.amountWei !== null ? `Latest ${formatEth(newest.amountWei)}` : "Bid activity"}
            {oldest.blockTime < newest.blockTime
              ? ` · over ${formatSpan(oldest.blockTime, newest.blockTime)}`
              : ""}
          </p>
        </div>
      </div>
    </li>
  )
}
