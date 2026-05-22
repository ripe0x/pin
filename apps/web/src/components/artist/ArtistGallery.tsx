"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useAccount } from "wagmi"
import { useInfiniteQuery } from "@tanstack/react-query"
import { formatEther } from "viem"
import type { GalleryItem, GalleryPage } from "@/lib/artist-queries"
import type { SovereignAuctionLite } from "@/lib/auctions"
import { createProvider, type PinStatus } from "@/lib/pinning"
import { useThumbnailMedia } from "@/lib/use-thumbnail-media"
import { TokenPinStatus } from "@/components/preserve/TokenPinStatus"
import { DeployHouseCTA } from "@/components/auction/DeployHouseCTA"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { PlatformChip } from "@/components/PlatformChip"

export function ArtistGallery({
  artistAddress,
  initialPage,
}: {
  artistAddress: string
  initialPage: GalleryPage
}) {
  const { address: connectedAddress } = useAccount()
  const isOwner =
    !!connectedAddress &&
    connectedAddress.toLowerCase() === artistAddress.toLowerCase()
  const { houseAddress } = useArtistHouse(artistAddress)
  const showStartAuctionLink = isOwner && !!houseAddress

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<GalleryPage>({
    queryKey: ["artist-tokens", artistAddress.toLowerCase()],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await fetch(
        `/api/artist/${artistAddress}/tokens?page=${pageParam}&pageSize=${initialPage.pageSize}`,
      )
      if (!res.ok) throw new Error("Failed to load tokens")
      return res.json()
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    initialData: { pages: [initialPage], pageParams: [0] },
    // Keep the SSR-hydrated first page warm; refetches happen on tab focus
    // for non-initial pages but not for the seeded one.
    staleTime: 60_000,
  })

  // Defensive dedup by `${contract}:${tokenId}` — guards against a paged
  // response somehow returning a token already shown on a prior page (e.g.
  // a CDN cache-key bug serving the same page twice).
  //
  // Sort: works currently in a Sovereign auction cluster at the top in
  // active → ending → listed order, then everything else. Within every
  // bucket, newest mint first (discovery order from `ORDER BY mint_block
  // DESC`).
  const items = useMemo<GalleryItem[]>(() => {
    const seen = new Set<string>()
    const deduped = (data?.pages ?? [])
      .flatMap((p) => p.tokens)
      .filter((item) => {
        const key = `${item.contract.toLowerCase()}:${item.tokenId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    const bucketRank = (item: GalleryItem) => {
      if (!item.auction) return 3
      if (item.auction.bucket === "active") return 0
      if (item.auction.bucket === "ending") return 1
      return 2
    }
    return deduped
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => {
        const r = bucketRank(a.item) - bucketRank(b.item)
        if (r !== 0) return r
        // Within a bucket, preserve discovery order, which is mint-recency
        // (newest first) from the `ORDER BY mint_block DESC` query.
        return a.idx - b.idx
      })
      .map((entry) => entry.item)
  }, [data])

  // Pin-status check across all loaded items. Re-runs as more pages load.
  const [pinStatuses, setPinStatuses] = useState<Map<string, PinStatus>>(
    new Map(),
  )
  const [hasProvider, setHasProvider] = useState(false)

  useEffect(() => {
    const providerType = localStorage.getItem("cg_pin_provider")
    const apiKey = localStorage.getItem("cg_pin_key")
    if (!providerType || !apiKey) return

    setHasProvider(true)
    const provider = createProvider(providerType as any, apiKey)

    const cids = new Set<string>()
    for (const item of items) {
      if (item.metadataCid) cids.add(item.metadataCid)
      if (item.mediaCid) cids.add(item.mediaCid)
    }

    let cancelled = false
    async function checkAll() {
      const statuses = new Map<string, PinStatus>()
      await Promise.all(
        Array.from(cids).map(async (cid) => {
          try {
            const status = await provider.checkPin(cid)
            statuses.set(cid, status)
          } catch {
            statuses.set(cid, "unknown")
          }
        }),
      )
      if (!cancelled) setPinStatuses(statuses)
    }
    checkAll()
    return () => {
      cancelled = true
    }
  }, [items])

  // Infinite-scroll sentinel: trigger fetchNextPage when the bottom marker
  // enters the viewport (with a 600px margin so the next page starts loading
  // before the user actually hits the end).
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !hasNextPage) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          fetchNextPage()
        }
      },
      { rootMargin: "600px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  if (initialPage.total === 0) {
    return (
      <div className="space-y-6">
        {isOwner && (
          <div className="max-w-xl space-y-3">
            <DeployHouseCTA artistAddress={artistAddress} />
            {showStartAuctionLink && (
              <Link
                href="/auction/new"
                className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
              >
                Start an auction →
              </Link>
            )}
          </div>
        )}
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No works found</p>
          <p className="text-sm mt-1">
            We don&apos;t see any works on supported platforms (Foundation,
            Manifold, SuperRare, Sovereign, Transient) for this address yet.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {isOwner && (
        <div className="max-w-xl space-y-3">
          <DeployHouseCTA artistAddress={artistAddress} />
          {showStartAuctionLink && (
            <Link
              href="/auction/new"
              className="block w-full text-center text-sm font-medium py-3 border border-gray-200 hover:border-gray-400 transition-colors"
            >
              Start an auction →
            </Link>
          )}
        </div>
      )}
      <div className="columns-1 sm:columns-2 lg:columns-4 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
        {items.map((item) => (
          <GalleryCard
            key={`${item.contract}:${item.tokenId}`}
            item={item}
            pinStatuses={pinStatuses}
            hasProvider={hasProvider}
            isOwner={isOwner}
          />
        ))}
      </div>
      {hasNextPage && (
        <div
          ref={sentinelRef}
          className="py-12 text-center text-sm text-gray-400"
        >
          {isFetchingNextPage ? "Loading more…" : ""}
        </div>
      )}
    </div>
  )
}

function getItemPinStatus(
  item: GalleryItem,
  pinStatuses: Map<string, PinStatus>,
): PinStatus | null {
  const mediaSt = item.mediaCid ? pinStatuses.get(item.mediaCid) : undefined
  const metaSt = item.metadataCid
    ? pinStatuses.get(item.metadataCid)
    : undefined

  if (mediaSt === "pinned" || mediaSt === "queued") return "pinned"
  if (metaSt === "pinned" || metaSt === "queued") return "pinned"

  if (mediaSt || metaSt) return "unknown"

  return null
}

function GalleryCard({
  item,
  pinStatuses,
  hasProvider,
  isOwner,
}: {
  item: GalleryItem
  pinStatuses: Map<string, PinStatus>
  hasProvider: boolean
  isOwner: boolean
}) {
  const href = `/${item.contract}/${item.tokenId}`
  const pinStatus = hasProvider ? getItemPinStatus(item, pinStatuses) : null
  const [ratio, setRatio] = useState<number | null>(null)
  const { kind, imgSrc, imgRef, onImgError, videoSrc, onVideoError } =
    useThumbnailMedia(item.imageUrl, 800)

  const isActive = item.auction?.bucket === "active"
  const borderClass = isActive
    ? "border-fg group-hover:border-fg"
    : "border-gray-200 group-hover:border-gray-400"

  return (
    <Link href={href} className={`group block border transition-colors ${borderClass}`}>
      {/* Artwork field. The caption sits in a tinted footer directly
          beneath it (same bg-surface-muted + border-t treatment as the
          auction panel's settlement block) so the title stays visually
          anchored to its artwork rather than floating free. */}
      <div
        className="relative overflow-hidden bg-gray-100"
        style={{ aspectRatio: ratio ?? 1 }}
      >
        <PlatformChip platform={item.platform} />
        {kind === "failed" ? null : kind === "video" ? (
          <video
            src={videoSrc}
            className="block w-full h-auto"
            muted
            playsInline
            preload="metadata"
            onError={onVideoError}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              if (v.videoWidth && v.videoHeight) {
                setRatio(v.videoWidth / v.videoHeight)
              }
            }}
          />
        ) : (
          <img
            ref={imgRef}
            src={imgSrc}
            alt={item.title}
            className="block w-full h-auto"
            loading="lazy"
            onError={onImgError}
            onLoad={(e) => {
              const img = e.currentTarget
              if (img.naturalWidth && img.naturalHeight) {
                setRatio(img.naturalWidth / img.naturalHeight)
              }
            }}
          />
        )}
      </div>
      <div className="px-3 py-2.5 bg-surface-muted border-t border-gray-100 space-y-1.5">
        <p className="text-[11px] font-mono text-fg tracking-tight truncate group-hover:underline underline-offset-2">
          {item.title}
        </p>
        {item.auction ? (
          <AuctionCaption auction={item.auction} />
        ) : (
          pinStatus && <TokenPinStatus status={pinStatus} />
        )}
      </div>
    </Link>
  )
}

// Auction status as a label/value row, borrowing the auction panel's
// settlement/bid-history treatment: muted label on the left, fg value
// (tabular-nums) on the right, with a live/upcoming dot and countdown
// rendered as a subtle timestamp beside the label.
function AuctionCaption({ auction }: { auction: SovereignAuctionLite }) {
  if (auction.bucket === "listed") {
    return (
      <div className="flex items-baseline justify-between gap-2 text-[11px] font-mono">
        <span className="text-fg-muted">Reserve</span>
        <span className="tabular-nums text-fg shrink-0">
          {formatEth(auction.reservePrice)} ETH
        </span>
      </div>
    )
  }
  const isLive = auction.bucket === "active"
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px] font-mono">
      <span className="inline-flex items-baseline gap-1.5 min-w-0 text-fg-muted">
        <span
          className={`self-center h-1.5 w-1.5 shrink-0 rounded-full ${
            isLive ? "bg-status-live animate-pulse" : "bg-status-upcoming"
          }`}
          aria-hidden
        />
        <span>Top bid</span>
        <span className="text-fg-subtle shrink-0 truncate">
          {isLive ? <LiveCountdown endTimeSec={Number(auction.endTime)} /> : "ending"}
        </span>
      </span>
      <span className="tabular-nums text-fg shrink-0">
        {formatEth(auction.amount)} ETH
      </span>
    </div>
  )
}

function LiveCountdown({ endTimeSec }: { endTimeSec: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  const remaining = Math.max(0, endTimeSec - now)
  if (remaining === 0) return <>ending</>
  const d = Math.floor(remaining / 86400)
  const h = Math.floor((remaining % 86400) / 3600)
  const m = Math.floor((remaining % 3600) / 60)
  const s = remaining % 60
  if (d > 0) return <>{`${d}d ${h}h`}</>
  if (h > 0) return <>{`${h}h ${m}m`}</>
  if (m > 0) return <>{`${m}m ${s}s`}</>
  return <>{`${s}s`}</>
}

function formatEth(wei: string, decimals = 4): string {
  try {
    const f = formatEther(BigInt(wei))
    const [whole, frac = ""] = f.split(".")
    if (frac.length === 0) return whole
    const trimmed = frac.slice(0, decimals).replace(/0+$/, "")
    return trimmed ? `${whole}.${trimmed}` : whole
  } catch {
    return "0"
  }
}

