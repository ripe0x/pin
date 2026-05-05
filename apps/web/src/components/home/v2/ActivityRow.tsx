import Link from "next/link"
import type { EnrichedActivityEvent } from "@/lib/v2-activity-types"
import { formatEth, formatTimeAgo, truncateAddress } from "./format"

type Props = {
  event: EnrichedActivityEvent
}

/**
 * Presentational row for the activity feed. Pure props, sync render —
 * works on either side of the server/client boundary. Data resolution
 * (token metadata, artist identity, media URL) happens upstream in
 * `enrichActivityEvents`. This lets the lazy-scroll loader append rows
 * client-side without an RSC round-trip per page.
 */
export function ActivityRow({ event }: Props) {
  const {
    artistDisplayName,
    artistAvatarUrl,
    tokenTitle,
    mediaUrl,
    isVideo,
  } = event

  const tokenHref =
    event.tokenContract && event.tokenId
      ? `/${event.tokenContract}/${event.tokenId}`
      : null
  const artistHref = `/artist/${event.artist}`

  const verb = renderVerb(event)
  const subline = renderSubline(event)

  return (
    <li className="border-t border-gray-200 py-4 px-1">
      <div className="flex items-start gap-4">
        <span className="font-mono text-xs text-gray-400 tabular-nums w-12 shrink-0 pt-0.5">
          {formatTimeAgo(event.blockTime)}
        </span>

        <div className="h-10 w-10 shrink-0 bg-gray-100 overflow-hidden flex items-center justify-center">
          {mediaUrl && tokenHref ? (
            <Link href={tokenHref} className="block h-full w-full">
              {isVideo ? (
                <video
                  src={mediaUrl}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-cover"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mediaUrl}
                  alt={tokenTitle ?? ""}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              )}
            </Link>
          ) : artistAvatarUrl ? (
            <Link href={artistHref} className="block h-full w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={artistAvatarUrl}
                alt={artistDisplayName}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </Link>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
            <Link
              href={artistHref}
              className="font-medium hover:underline underline-offset-2"
            >
              {artistDisplayName}
            </Link>
            <span className="text-gray-500"> {verb} </span>
            {tokenTitle ? (
              tokenHref ? (
                <Link
                  href={tokenHref}
                  className="text-fg hover:underline underline-offset-2"
                >
                  {tokenTitle}
                </Link>
              ) : (
                <span>{tokenTitle}</span>
              )
            ) : null}
          </p>
          {subline ? (
            <p className="font-mono text-[11px] text-gray-400 mt-1 truncate">
              {subline}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function renderVerb(event: EnrichedActivityEvent): string {
  switch (event.kind) {
    case "house.deployed":
      return "deployed sovereign auction house"
    case "collection.deployed":
      return event.collectionName
        ? `deployed collection “${event.collectionName}”`
        : "deployed collection"
    case "auction.opened":
      return event.reserveWei !== null
        ? `opened auction · reserve ${formatEth(event.reserveWei)} ·`
        : "opened auction ·"
    case "auction.firstBid":
      return event.amountWei !== null
        ? `received first bid ${formatEth(event.amountWei)} on`
        : "received first bid on"
    case "auction.settled":
      return event.amountWei !== null
        ? `settled auction ${formatEth(event.amountWei)} ·`
        : "settled auction ·"
    case "auction.cancelled":
      return event.reserveWei !== null
        ? `cancelled auction · reserve ${formatEth(event.reserveWei)} ·`
        : "cancelled auction ·"
    case "sale.buyNow":
      return event.amountWei !== null
        ? `sold ${formatEth(event.amountWei)} ·`
        : "sold ·"
    case "mint":
      return "minted"
  }
}

function renderSubline(event: EnrichedActivityEvent): string | null {
  const parts: string[] = []

  if (event.kind === "house.deployed" && event.house) {
    parts.push(event.house)
  }
  if (event.kind === "collection.deployed" && event.collection) {
    parts.push(event.collection)
  }
  if (event.kind === "auction.firstBid" && event.counterparty) {
    parts.push(`by ${truncateAddress(event.counterparty)}`)
  }
  if (event.kind === "auction.settled" && event.counterparty) {
    parts.push(`→ ${truncateAddress(event.counterparty)}`)
  }
  if (event.kind === "sale.buyNow" && event.counterparty) {
    parts.push(`→ ${truncateAddress(event.counterparty)}`)
  }
  if (event.tokenContract && event.kind !== "house.deployed") {
    parts.push(truncateAddress(event.tokenContract))
  }

  return parts.length > 0 ? parts.join(" · ") : null
}
