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
  amount: bigint
  reservePrice: bigint
  endTime: number
  firstBidTime: number
  artistAddress: string
  artistDisplayName: string
  artistAvatarUrl: string | null
  /**
   * Source platform for the god-mode debug chip. Optional — the chip
   * itself no-ops for non-allowlisted wallets and when the toggle is
   * off, so passing this on every card is free.
   */
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
 * A composite "work + artist" card. Top row is split 50/50: work image
 * on the left, artist on the right (each its own click target, going to
 * the token page and the artist page respectively). Bottom row is a
 * full-width strip with the work's title and price — it labels the
 * whole card, since the card represents one work.
 */
export async function WorkArtistCard({
  contract,
  tokenId,
  amount,
  reservePrice,
  endTime,
  firstBidTime,
  artistAddress,
  artistDisplayName,
  artistAvatarUrl,
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

  const hasBid = firstBidTime > 0 && amount > 0n
  const priceLine = hasBid
    ? `${formatEth(amount)} · ${formatTimeLeft(endTime)}`
    : `${formatEth(reservePrice)} reserve`

  const tokenHref = `/${contract}/${tokenId}`
  const artistHref = `/artist/${artistAddress}`

  return (
    <div className="relative border border-gray-200 transition-colors hover:border-gray-400 flex flex-col h-full overflow-hidden">
      <PlatformChip platform={platform} />
      <div className="grid grid-cols-2">
        <Link
          href={tokenHref}
          className="relative aspect-square overflow-hidden bg-gray-100 border-r border-gray-100"
        >
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
        </Link>

        <Link
          href={artistHref}
          className="flex flex-col items-center justify-center gap-3 p-4 min-w-0"
        >
          <div className="h-16 w-16 rounded-full overflow-hidden bg-gray-100 shrink-0">
            {artistAvatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={artistAvatarUrl}
                alt={artistDisplayName}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : null}
          </div>
          <p className="text-xs font-medium text-center truncate w-full">
            {artistDisplayName}
          </p>
        </Link>
      </div>

      <Link
        href={tokenHref}
        className="block p-3 space-y-1 border-t border-gray-100 min-w-0"
      >
        <p className="text-sm font-medium truncate">{title}</p>
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          {priceLine}
        </p>
      </Link>
    </div>
  )
}
