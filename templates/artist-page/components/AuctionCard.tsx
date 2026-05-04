/**
 * Auction grid card. Mirrors PND's `GalleryCard` from
 * `apps/web/src/components/artist/ArtistGallery.tsx`:
 *
 *  - `border border-gray-200 hover:border-gray-400` chrome only, no fill
 *  - native image aspect ratio (set client-side from naturalWidth/Height)
 *  - `p-4 text-base font-medium leading-tight truncate` title strip
 *  - status caption (replaces PND's `TokenPinStatus`) on the right of
 *    the title row in the same compact mono caps style used elsewhere
 *
 * Active auctions (live with at least one bid, time still remaining) get
 * a highlighted border + a ticking countdown alongside the current bid.
 */
import { AuctionCardImage } from "./AuctionCardImage"
import { LiveCountdown } from "./LiveCountdown"
import Link from "next/link"
import type { AuctionSummary } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { formatEth } from "@/lib/format"

type Bucket = "active" | "ending" | "listed" | "settled" | "cancelled"

function bucketFor(auction: AuctionSummary): Bucket {
  if (auction.status === "settled") return "settled"
  if (auction.status === "cancelled") return "cancelled"
  if (auction.status === "upcoming") return "listed"
  if (auction.amount === "0" || auction.firstBidTime === "0") return "listed"
  const endTime = Number(auction.endTime)
  const nowSec = Math.floor(Date.now() / 1000)
  if (endTime > 0 && endTime <= nowSec) return "ending"
  return "active"
}

export async function AuctionCard({ auction }: { auction: AuctionSummary }) {
  const metadata = await getTokenMetadata(auction.tokenContract, auction.tokenId)
  const image = metadata?.imageSmall ?? metadata?.image ?? null
  const title = metadata?.name ?? `#${auction.tokenId}`
  const bucket = bucketFor(auction)
  const isActive = bucket === "active"

  const borderClass = isActive
    ? "border-fg hover:border-fg"
    : "border-gray-200 hover:border-gray-400"

  return (
    <div
      className={`group relative border transition-colors ${borderClass}`}
    >
      <Link href={`/auction/${auction.auctionId}`} className="block">
        <AuctionCardImage src={image} alt={title} />
        <div className="p-4 flex items-center justify-between gap-2">
          <p className="text-base font-medium leading-tight truncate">
            {title}
          </p>
          <StatusCaption auction={auction} bucket={bucket} />
        </div>
      </Link>
    </div>
  )
}

function StatusCaption({
  auction,
  bucket,
}: {
  auction: AuctionSummary
  bucket: Bucket
}) {
  if (bucket === "settled" && auction.finalPrice) {
    return (
      <Caption muted>
        {formatEth(auction.finalPrice)} ETH
      </Caption>
    )
  }
  if (bucket === "cancelled") {
    return <Caption muted>Cancelled</Caption>
  }
  if (bucket === "listed") {
    return (
      <Caption muted>
        {formatEth(auction.reservePrice)} reserve
      </Caption>
    )
  }
  if (bucket === "ending") {
    return (
      <Caption>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-status-upcoming" aria-hidden />
          Top bid {formatEth(auction.amount)} ETH · ending
        </span>
      </Caption>
    )
  }
  return (
    <Caption>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-status-live animate-pulse" aria-hidden />
        Top bid {formatEth(auction.amount)} ETH ·{" "}
        <LiveCountdown endTimeSec={Number(auction.endTime)} />
      </span>
    </Caption>
  )
}

function Caption({
  children,
  muted = false,
}: {
  children: React.ReactNode
  muted?: boolean
}) {
  return (
    <span
      className={`text-[10px] font-mono uppercase tracking-wider shrink-0 whitespace-nowrap ${
        muted ? "text-gray-500" : "text-fg"
      }`}
    >
      {children}
    </span>
  )
}

export { bucketFor }
export type { Bucket }
