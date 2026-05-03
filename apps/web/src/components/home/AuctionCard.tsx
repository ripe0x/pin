import Link from "next/link"
import { formatEther } from "viem"
import { ipfsToHttp } from "@pin/shared"
import { resolveTokenMetadataDirect } from "@/lib/onchain-discovery"
import { PlatformChip } from "@/components/PlatformChip"
import type { PlatformId } from "@/lib/platforms/types"

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

type Props = {
  contract: string
  tokenId: string
  /**
   * Highest bid placed so far. `0n` means no bids yet — the card
   * falls back to showing `reservePrice` with a "reserve" label.
   */
  currentBidWei: bigint
  reservePrice: bigint
  /**
   * Auction end time, unix seconds. `0` means no bids yet (the
   * platform only stamps endTime when the first bid lands). When
   * `> 0` but in the past, the auction is settling or the indexer
   * hasn't caught up — the card shows the bid without a countdown
   * rather than a stale "ending" label.
   */
  endTime: number
  platform?: PlatformId
}

function formatEth(wei: bigint): string {
  const eth = formatEther(wei)
  const num = Number(eth)
  if (num >= 1) return `${num.toFixed(2)} ETH`
  if (num >= 0.01) return `${num.toFixed(3)} ETH`
  return `${num.toFixed(4)} ETH`
}

function formatTimeLeft(endTimeSec: number): string {
  const diffSec = endTimeSec - Math.floor(Date.now() / 1000)
  if (diffSec <= 0) return "ending"
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min}m left`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h left`
  const day = Math.floor(hr / 24)
  return `${day}d left`
}

/**
 * Auction-only card for the active-auctions carousel. Square token image
 * with title + price strip below — denser than WorkArtistCard so the
 * horizontal strip can show many works at once.
 */
export async function AuctionCard({
  contract,
  tokenId,
  currentBidWei,
  reservePrice,
  endTime,
  platform,
}: Props) {
  const meta = await resolveTokenMetadataDirect(contract, tokenId).catch(
    () => null,
  )
  const title = meta?.name ?? `#${tokenId}`
  const mediaUrl = meta?.image ? ipfsToHttp(meta.image) : null
  const isVideo = mediaUrl
    ? VIDEO_EXTENSIONS.some((ext) =>
        mediaUrl.split("?")[0].toLowerCase().endsWith(ext),
      )
    : false

  const hasBid = currentBidWei > 0n
  const nowSec = Math.floor(Date.now() / 1000)
  const isCountingDown = hasBid && endTime > nowSec
  const priceLine = isCountingDown
    ? `${formatEth(currentBidWei)} · ${formatTimeLeft(endTime)}`
    : hasBid
      ? `${formatEth(currentBidWei)} bid`
      : `${formatEth(reservePrice)} reserve`

  const tokenHref = `/${contract}/${tokenId}`

  return (
    <Link
      href={tokenHref}
      className="relative block w-48 sm:w-56 shrink-0 border border-gray-200 transition-colors hover:border-gray-400 overflow-hidden"
    >
      <PlatformChip platform={platform} />
      <div className="relative aspect-square overflow-hidden bg-gray-100">
        {mediaUrl && isVideo ? (
          <video
            src={mediaUrl}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl}
            alt={title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : null}
      </div>
      <div className="p-3 space-y-1 border-t border-gray-100 min-w-0">
        <p className="text-sm font-medium truncate">{title}</p>
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          {priceLine}
        </p>
      </div>
    </Link>
  )
}
