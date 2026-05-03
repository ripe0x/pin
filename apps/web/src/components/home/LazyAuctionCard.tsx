"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { formatEther } from "viem"
import { PlatformChip } from "@/components/PlatformChip"
import type { PlatformId } from "@/lib/platforms/types"

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

type Props = {
  contract: string
  tokenId: string
  currentBidWei: bigint
  reservePrice: bigint
  endTime: number
  platform?: PlatformId
}

type Metadata = { title: string; mediaUrl: string | null; isVideo: boolean }

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
 * Client-side lazy variant of `AuctionCard`. Renders a skeleton until
 * the card scrolls within ~400px of the viewport, then fetches token
 * metadata from `/api/meta/[contract]/[tokenId]` (1h-cached) and
 * upgrades to the full card.
 *
 * Bid + reserve + endTime are all known up-front (passed by parent
 * from `ActiveAuctionSummary`), so the price line renders immediately
 * — only the title and image wait on the metadata fetch.
 */
export function LazyAuctionCard({
  contract,
  tokenId,
  currentBidWei,
  reservePrice,
  endTime,
  platform,
}: Props) {
  const ref = useRef<HTMLAnchorElement>(null)
  const [meta, setMeta] = useState<Metadata | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)

  useEffect(() => {
    if (hasLoaded) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === "undefined") {
      // Ref didn't attach or IO unavailable — fall back to loading
      // on mount so the card is never permanently stuck on a
      // placeholder.
      setHasLoaded(true)
      return
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setHasLoaded(true)
          io.disconnect()
        }
      },
      // 400px horizontal head-start so cards finish loading before they
      // physically scroll into view — feels instantaneous as the user
      // drags through the strip.
      { rootMargin: "0px 400px 0px 400px" },
    )
    io.observe(el)

    // Safety net: if IO never fires (rare iframe / sandbox quirks),
    // fall back to loading after a generous delay so the card still
    // upgrades from its placeholder. In normal browsers IO triggers
    // long before this elapses for any visible card.
    const fallback = setTimeout(() => setHasLoaded(true), 3000)

    return () => {
      io.disconnect()
      clearTimeout(fallback)
    }
  }, [hasLoaded])

  useEffect(() => {
    if (!hasLoaded) return
    let cancelled = false
    fetch(`/api/meta/${contract}/${tokenId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        const mediaUrl = (data.mediaUri as string | null) ?? null
        const title = (data.metadata?.name as string | undefined) ?? `#${tokenId}`
        const isVideo = mediaUrl
          ? VIDEO_EXTENSIONS.some((ext) =>
              mediaUrl.split("?")[0].toLowerCase().endsWith(ext),
            )
          : false
        setMeta({ title, mediaUrl, isVideo })
      })
      .catch(() => {
        if (cancelled) return
        setMeta({ title: `#${tokenId}`, mediaUrl: null, isVideo: false })
      })
    return () => {
      cancelled = true
    }
  }, [hasLoaded, contract, tokenId])

  const hasBid = currentBidWei > 0n
  const nowSec = Math.floor(Date.now() / 1000)
  const isCountingDown = hasBid && endTime > nowSec
  const priceLine = isCountingDown
    ? `${formatEth(currentBidWei)} · ${formatTimeLeft(endTime)}`
    : hasBid
      ? `${formatEth(currentBidWei)} bid`
      : `${formatEth(reservePrice)} reserve`

  const tokenHref = `/${contract}/${tokenId}`
  const title = meta?.title ?? `#${tokenId}`

  return (
    <Link
      ref={ref}
      href={tokenHref}
      className="relative block w-48 sm:w-56 shrink-0 border border-gray-200 transition-colors hover:border-gray-400 overflow-hidden"
    >
      <PlatformChip platform={platform} />
      <div className="relative aspect-square overflow-hidden bg-gray-100">
        {meta?.mediaUrl && meta.isVideo ? (
          <video
            src={meta.mediaUrl}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : meta?.mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={meta.mediaUrl}
            alt={title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : null}
      </div>
      <div className="p-3 space-y-1 border-t border-gray-100 min-w-0">
        <p
          className={`text-sm font-medium truncate ${meta ? "" : "text-gray-300"}`}
        >
          {title}
        </p>
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          {priceLine}
        </p>
      </div>
    </Link>
  )
}
