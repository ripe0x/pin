/**
 * Auction grid card. Mirrors the PND main app's `WorkArtistCard` pattern:
 * border-only chrome, square aspect-ratio image, full-width strip below
 * with title + status. No background fill, no rounded corners — the image
 * fills its slot edge-to-edge.
 */
import Link from "next/link"
import type { AuctionSummary } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { formatEth, formatTimeRemaining } from "@/lib/format"

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

export async function AuctionCard({ auction }: { auction: AuctionSummary }) {
  const metadata = await getTokenMetadata(auction.tokenContract, auction.tokenId)
  const image = metadata?.imageSmall ?? metadata?.image ?? null
  const title = metadata?.name ?? `#${auction.tokenId}`
  const isVideo = image
    ? VIDEO_EXTENSIONS.some((ext) =>
        image.split("?")[0].toLowerCase().endsWith(ext),
      )
    : false

  const priceLine = priceLabelFor(auction)
  const statusLabel = statusLabelFor(auction)

  return (
    <Link
      href={`/auction/${auction.auctionId}`}
      className="relative border border-gray-200 transition-colors hover:border-gray-400 flex flex-col h-full overflow-hidden"
    >
      <div className="relative aspect-square overflow-hidden bg-gray-100">
        {image && isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={image}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : null}
      </div>

      <div className="block p-3 space-y-1 border-t border-gray-100 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${statusDotColorFor(auction)}`}
            aria-hidden
          />
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
            {statusLabel}
          </span>
        </div>
        <p className="text-sm font-medium truncate">{title}</p>
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          {priceLine}
        </p>
      </div>
    </Link>
  )
}

function statusLabelFor(auction: AuctionSummary): string {
  switch (auction.status) {
    case "live":
      return "Live"
    case "upcoming":
      return "Reserve"
    case "settled":
      return "Sold"
    case "cancelled":
      return "Cancelled"
  }
}

function statusDotColorFor(auction: AuctionSummary): string {
  switch (auction.status) {
    case "live":
      return "bg-status-live"
    case "upcoming":
      return "bg-status-upcoming"
    case "settled":
      return "bg-status-sold"
    case "cancelled":
      return "bg-gray-400"
  }
}

function priceLabelFor(auction: AuctionSummary): string {
  if (auction.status === "settled" && auction.finalPrice) {
    return `${formatEth(auction.finalPrice)} ETH`
  }
  if (auction.status === "cancelled") return ""
  if (auction.status === "upcoming") {
    return `${formatEth(auction.reservePrice)} ETH reserve`
  }
  // live
  if (auction.amount === "0") {
    return `${formatEth(auction.reservePrice)} ETH reserve`
  }
  const endTime = Number(auction.endTime)
  if (endTime > 0) {
    const remaining = endTime - Math.floor(Date.now() / 1000)
    if (remaining > 0) {
      return `${formatEth(auction.amount)} ETH · ${formatTimeRemaining(remaining)}`
    }
    return `${formatEth(auction.amount)} ETH · Ending`
  }
  return `${formatEth(auction.amount)} ETH`
}
