import Link from "next/link"
import { ipfsToHttp } from "@pin/shared"
import { resolveTokenMetadataDirect } from "@/lib/onchain-discovery"
import type { ActivityEvent } from "@/lib/indexer-queries"
import { formatEth, formatTimeAgo, truncateAddress } from "./format"

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

type Props = {
  event: ActivityEvent
  artistDisplayName: string
  artistAvatarUrl: string | null
}

/**
 * One row of the activity feed. Server component so we can resolve token
 * metadata inline (it's behind multiple cache layers — pgCache + an
 * in-process unstable_cache — so per-row reads are essentially free on
 * a warm cache).
 *
 * Layout: [time] [thumb?] [artist + verb-phrase / sub-line]. The artist's
 * name links to their portfolio; the work title links to the token page.
 */
export async function ActivityRow({
  event,
  artistDisplayName,
  artistAvatarUrl,
}: Props) {
  const meta =
    event.tokenContract && event.tokenId
      ? await resolveTokenMetadataDirect(
          event.tokenContract,
          event.tokenId,
        ).catch(() => null)
      : null

  const tokenTitle =
    meta?.name && meta.name !== `#${event.tokenId}`
      ? meta.name
      : event.tokenId
        ? `#${event.tokenId}`
        : null

  const mediaUrl = meta?.image ? ipfsToHttp(meta.image) : null
  const isVideo = mediaUrl
    ? VIDEO_EXTENSIONS.some((ext) =>
        mediaUrl.split("?")[0].toLowerCase().endsWith(ext),
      )
    : false

  const tokenHref =
    event.tokenContract && event.tokenId
      ? `/${event.tokenContract}/${event.tokenId}`
      : null
  const artistHref = `/artist/${event.artist}`

  // Verb + amount phrase, varying by event kind. Kept terse — the row's
  // meaning lives in the verb, the rest is context.
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

function renderVerb(event: ActivityEvent): string {
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

function renderSubline(event: ActivityEvent): string | null {
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
