/**
 * Auction grid card. Mirrors PND's `GalleryCard` from
 * `apps/web/src/components/artist/ArtistGallery.tsx`:
 *
 *  - `border border-gray-200 hover:border-gray-400` chrome only, no fill
 *  - native image aspect ratio (set client-side from naturalWidth/Height)
 *  - `p-4 text-base font-medium leading-tight truncate` title strip
 *  - status caption (replaces PND's `TokenPinStatus`) on the right of
 *    the title row in the same compact mono caps style used elsewhere
 */
import { AuctionCardImage } from "./AuctionCardImage"
import Link from "next/link"
import type { AuctionSummary } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { formatEth, formatTimeRemaining } from "@/lib/format"

export async function AuctionCard({ auction }: { auction: AuctionSummary }) {
  const metadata = await getTokenMetadata(auction.tokenContract, auction.tokenId)
  const image = metadata?.imageSmall ?? metadata?.image ?? null
  const title = metadata?.name ?? `#${auction.tokenId}`

  return (
    <div className="group relative border border-gray-200 transition-colors hover:border-gray-400">
      <Link href={`/auction/${auction.auctionId}`} className="block">
        <AuctionCardImage src={image} alt={title} />
        <div className="p-4 flex items-center justify-between gap-2">
          <p className="text-base font-medium leading-tight truncate">
            {title}
          </p>
          <StatusBadge auction={auction} />
        </div>
      </Link>
    </div>
  )
}

function StatusBadge({ auction }: { auction: AuctionSummary }) {
  const label = priceLabelFor(auction)
  if (!label) return null
  return (
    <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500 shrink-0 whitespace-nowrap">
      {label}
    </span>
  )
}

function priceLabelFor(auction: AuctionSummary): string {
  if (auction.status === "settled" && auction.finalPrice) {
    return `${formatEth(auction.finalPrice)} ETH`
  }
  if (auction.status === "cancelled") return "Cancelled"
  if (auction.status === "upcoming") {
    return `${formatEth(auction.reservePrice)} reserve`
  }
  if (auction.amount === "0") {
    return `${formatEth(auction.reservePrice)} reserve`
  }
  const endTime = Number(auction.endTime)
  if (endTime > 0) {
    const remaining = endTime - Math.floor(Date.now() / 1000)
    if (remaining > 0) {
      return `${formatEth(auction.amount)} · ${formatTimeRemaining(remaining)}`
    }
    return `${formatEth(auction.amount)} · ending`
  }
  return `${formatEth(auction.amount)} ETH`
}
