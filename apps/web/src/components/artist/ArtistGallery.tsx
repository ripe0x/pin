"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { formatEther } from "viem"
import type { GalleryItem, GalleryPage } from "@/lib/artist-queries"
import type { WorkAvailability } from "@/lib/artist-availability"
import { createProvider, type PinStatus } from "@/lib/pinning"
import { useThumbnailMedia } from "@/lib/use-thumbnail-media"
import { TokenPinStatus } from "@/components/preserve/TokenPinStatus"
import { PlatformChip } from "@/components/PlatformChip"
import { TokenCard } from "@/components/TokenCard"
import { MuriTileBadge } from "@/components/token/MuriBadge"

export function ArtistGallery({
  artistAddress,
  initialPage,
}: {
  artistAddress: string
  initialPage: GalleryPage
}) {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    error,
    refetch,
    isFetching,
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
  // Availability ranking happens across the full inventory in SQL before
  // pagination. Resorting loaded pages here would make the order jump as the
  // user scrolls and could hide older available works behind newer pages.
  const items = useMemo<GalleryItem[]>(() => {
    const seen = new Set<string>()
    return (data?.pages ?? [])
      .flatMap((p) => p.tokens)
      .filter((item) => {
        const key = `${item.contract.toLowerCase()}:${item.tokenId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }, [data])

  const firstPage = data?.pages[0] ?? initialPage
  const loadedCount = items.length

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

  if (firstPage.total === 0) {
    return (
      <div className="space-y-6">
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No works found</p>
          <p className="text-sm mt-1">
            No works were found for this address across Foundation,
            Manifold, Mint, PND, SuperRare, or Transient Labs.
          </p>
          <p className="text-xs mt-3 text-gray-500">
            This does not mean the artist has never created work. It means PND
            has not found work from its supported sources yet.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <GalleryCoverage
        availableTotal={firstPage.availableTotal}
        total={firstPage.total}
        coverage={firstPage.coverage}
      />

      {isError ? (
        <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p>{error instanceof Error ? error.message : "Some works could not be loaded."}</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-2 underline underline-offset-2 disabled:opacity-50"
            disabled={isFetching}
          >
            {isFetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <GalleryCard
            key={`${item.contract}:${item.tokenId}`}
            item={item}
            pinStatuses={pinStatuses}
            hasProvider={hasProvider}
          />
        ))}
      </div>
      {hasNextPage && (
        <div
          ref={sentinelRef}
          className="py-8 text-center text-sm text-gray-500 space-y-2"
        >
          <p>
            Showing {loadedCount} of {firstPage.total} works
          </p>
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="border border-gray-300 px-3 py-1.5 text-xs text-fg hover:border-gray-500 disabled:opacity-50"
          >
            {isFetchingNextPage ? "Loading more…" : "Load more"}
          </button>
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
}: {
  item: GalleryItem
  pinStatuses: Map<string, PinStatus>
  hasProvider: boolean
}) {
  const href = `/${item.contract}/${item.tokenId}`
  const pinStatus = hasProvider ? getItemPinStatus(item, pinStatuses) : null
  const delivery = item.mediaDelivery
  const derivativeUrl =
    delivery?.status === "ready"
      ? delivery.posterUrl ?? delivery.thumbnailUrl
      : null
  const sourceUrl = derivativeUrl ?? item.imageUrl
  const media = useThumbnailMedia(sourceUrl, 800, delivery?.kind)
  const [loaded, setLoaded] = useState(false)
  const [measuredRatio, setMeasuredRatio] = useState<number | null>(null)
  const storedRatio =
    delivery?.width && delivery.height ? delivery.width / delivery.height : null
  const ratio = storedRatio ?? measuredRatio ?? 1
  const explicitState = !sourceUrl
    ? "No preview available"
    : delivery?.status === "unsupported"
        ? "Interactive media, open the work to view"
        : null
  const showMedia = !explicitState && media.kind !== "failed"

  useEffect(() => {
    setLoaded(false)
    setMeasuredRatio(null)
  }, [sourceUrl])

  const isActive = item.availability?.status === "active"

  return (
    <TokenCard
      href={href}
      title={item.title}
      isActive={isActive}
      meta={
        <div className="space-y-1.5">
          {item.availability ? (
            <AvailabilityCaption availability={item.availability} />
          ) : (
            <p className="text-[10px] font-mono text-fg-subtle">
              Created via {platformLabel(item.platform)} · not currently listed
            </p>
          )}
          {pinStatus ? <TokenPinStatus status={pinStatus} /> : null}
        </div>
      }
    >
      <div
        className="relative overflow-hidden bg-gray-100"
        style={{ aspectRatio: ratio }}
      >
        <PlatformChip platform={item.platform} />
        {item.muriUriCount != null && (
          <div className="absolute right-1.5 top-1.5 z-10">
            <MuriTileBadge uriCount={item.muriUriCount} />
          </div>
        )}
        {showMedia && media.kind === "video" ? (
          <video
            src={media.videoSrc}
            aria-label={item.title}
            className={`block h-auto w-full transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
            muted
            playsInline
            preload="metadata"
            onError={media.onVideoError}
            onLoadedData={(event) => {
              const video = event.currentTarget
              setLoaded(true)
              if (video.videoWidth && video.videoHeight) {
                setMeasuredRatio(video.videoWidth / video.videoHeight)
              }
            }}
          />
        ) : showMedia ? (
          <img
            ref={media.imgRef}
            src={media.imgSrc}
            alt={item.title}
            width={delivery?.width ?? undefined}
            height={delivery?.height ?? undefined}
            className={`block h-auto w-full transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
            loading="lazy"
            decoding="async"
            onError={media.onImgError}
            onLoad={(e) => {
              const img = e.currentTarget
              setLoaded(true)
              if (img.naturalWidth && img.naturalHeight) {
                setMeasuredRatio(img.naturalWidth / img.naturalHeight)
              }
            }}
          />
        ) : null}
        {!showMedia || !loaded ? (
          <div
            role="img"
            aria-label={
              explicitState ??
              (media.kind === "failed"
                ? `${item.title} preview unavailable`
                : `${item.title} preview loading`)
            }
            className={`absolute inset-0 ${showMedia ? "skeleton" : "bg-gray-100"}`}
          />
        ) : null}
      </div>
    </TokenCard>
  )
}

function AvailabilityCaption({
  availability,
}: {
  availability: WorkAvailability
}) {
  const isAuction = availability.kind === "auction"
  const isLive = availability.status === "active"
  const label =
    availability.status === "buy-now"
      ? "Buy now"
      : availability.status === "listed"
        ? "Reserve"
        : availability.status === "settling"
          ? "Awaiting settlement"
          : "Top bid"
  const amount = availability.currentBid ?? availability.price
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px] font-mono">
        <span className="inline-flex items-baseline gap-1.5 min-w-0 text-fg-muted">
          {isAuction ? (
            <span
              className={`self-center h-1.5 w-1.5 shrink-0 rounded-full ${
                isLive ? "bg-status-live animate-pulse" : "bg-status-upcoming"
              }`}
              aria-hidden
            />
          ) : null}
          <span>{label}</span>
          {isAuction && availability.status === "active" ? (
            <span className="text-fg-subtle shrink-0 truncate">
              {availability.endTime ? (
                <LiveCountdown endTimeSec={Number(availability.endTime)} />
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="tabular-nums text-fg shrink-0">
          {formatEth(amount)} ETH
        </span>
      </div>
      <p className="text-[10px] font-mono text-fg-subtle">
        Available on {availabilitySourceLabel(availability.source)} ·{" "}
        {freshnessLabel(availability)}
      </p>
    </div>
  )
}

function GalleryCoverage({
  availableTotal,
  total,
  coverage,
}: {
  availableTotal: number
  total: number
  coverage: GalleryPage["coverage"]
}) {
  return (
    <div className="border-b border-gray-200 pb-4 space-y-1.5">
      <p className="text-sm text-fg">
        <span className="font-medium">{availableTotal} listed now</span>
        <span className="text-gray-400"> · </span>
        <span>{total} {total === 1 ? "work" : "works"}</span>
      </p>
      <p className="text-xs text-gray-500">
        Sources checked: {coverage.indexedSources.join(", ")}.
      </p>
      <p className="text-xs text-gray-500">{coverage.note}</p>
      {coverage.hiddenStaleSources.length > 0 ? (
        <p className="text-xs text-amber-700">
          Availability from {coverage.hiddenStaleSources.join(" and ")} is
          temporarily hidden because its latest observation is more than 15
          minutes old.
        </p>
      ) : null}
    </div>
  )
}

function availabilitySourceLabel(source: WorkAvailability["source"]): string {
  if (source === "pnd") return "PND"
  if (source === "foundation") return "Foundation"
  if (source === "superrare") return "SuperRare"
  return "Transient Labs"
}

function freshnessLabel(availability: WorkAvailability): string {
  if (availability.freshness === "fresh") {
    return "observed within 15 minutes"
  }
  return "onchain event state"
}

function platformLabel(platform: GalleryItem["platform"]): string {
  if (platform === "foundation") return "Foundation"
  if (platform === "superrareV2") return "SuperRare"
  if (platform === "transient") return "Transient Labs"
  if (platform === "manifold") return "Manifold"
  if (platform === "mint") return "Mint"
  if (platform === "sovereign") return "PND"
  return "another supported source"
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
