import Image from "next/image"
import Link from "next/link"
import type { AuctionSummary } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { formatEth, formatTimeRemaining } from "@/lib/format"

export async function AuctionCard({ auction }: { auction: AuctionSummary }) {
  const metadata = await getTokenMetadata(auction.tokenContract, auction.tokenId)
  const image = metadata?.imageSmall ?? metadata?.image ?? null
  const title = metadata?.name ?? `Token #${auction.tokenId}`

  const priceLabel = labelForCard(auction)

  return (
    <Link
      href={`/auction/${auction.auctionId}`}
      className="group flex flex-col overflow-hidden border border-[hsl(var(--border))] bg-[hsl(var(--background))] transition-colors hover:bg-[hsl(var(--muted))]"
    >
      <div className="relative aspect-square w-full overflow-hidden bg-[hsl(var(--muted))]">
        {image ? (
          <Image
            src={image}
            alt={title}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No preview
          </div>
        )}
        <StatusBadge status={auction.status} />
      </div>
      <div className="flex flex-col gap-1 p-4">
        <span className="line-clamp-1 text-base font-medium">{title}</span>
        <span className="text-sm text-[hsl(var(--muted-foreground))]">
          {priceLabel}
        </span>
      </div>
    </Link>
  )
}

function StatusBadge({ status }: { status: AuctionSummary["status"] }) {
  const map: Record<AuctionSummary["status"], { label: string; cls: string }> = {
    live: { label: "Live", cls: "bg-emerald-500 text-white" },
    upcoming: { label: "Reserve", cls: "bg-yellow-500 text-black" },
    settled: { label: "Sold", cls: "bg-black/80 text-white" },
    cancelled: { label: "Cancelled", cls: "bg-zinc-500 text-white" },
  }
  const { label, cls } = map[status]
  return (
    <span
      className={`absolute left-3 top-3 px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  )
}

function labelForCard(auction: AuctionSummary): string {
  if (auction.status === "settled" && auction.finalPrice) {
    return `Sold for ${formatEth(auction.finalPrice)} ETH`
  }
  if (auction.status === "cancelled") return "Cancelled"
  if (auction.status === "upcoming") {
    return `Reserve ${formatEth(auction.reservePrice)} ETH`
  }
  // live
  if (auction.amount === "0") {
    return `Reserve ${formatEth(auction.reservePrice)} ETH`
  }
  const endTime = Number(auction.endTime)
  if (endTime > 0) {
    const remaining = endTime - Math.floor(Date.now() / 1000)
    return `${formatEth(auction.amount)} ETH · ${formatTimeRemaining(remaining)}`
  }
  return `${formatEth(auction.amount)} ETH`
}
