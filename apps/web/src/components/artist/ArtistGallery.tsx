"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { formatEther } from "viem"
import { useInfiniteQuery } from "@tanstack/react-query"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import type { GalleryItem, GalleryPage } from "@/lib/artist-queries"
import { createProvider, type PinStatus } from "@/lib/pinning"
import { useIpfsGatewayFallback } from "@/lib/use-ipfs-fallback"
import { TokenPinStatus } from "@/components/preserve/TokenPinStatus"
import { DeployHouseCTA } from "@/components/auction/DeployHouseCTA"

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

function isVideoUrl(url: string): boolean {
  const path = url.split("?")[0].toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))
}

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
      <div className="text-center py-16 text-gray-400">
        <p className="text-lg">No works found</p>
        <p className="text-sm mt-1">
          This artist hasn&apos;t minted any works on Foundation yet.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {isOwner && (
        <div className="max-w-xl">
          <DeployHouseCTA artistAddress={artistAddress} />
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
  const isVideo = isVideoUrl(item.imageUrl)
  const pinStatus = hasProvider ? getItemPinStatus(item, pinStatuses) : null
  const [ratio, setRatio] = useState<number | null>(null)
  const { src: mediaSrc, onError: onMediaError } = useIpfsGatewayFallback(
    item.imageUrl,
  )

  return (
    <div className="group border border-gray-200 transition-colors hover:border-gray-400">
      <Link href={href}>
        <div
          className="relative overflow-hidden bg-gray-100"
          style={{ aspectRatio: ratio ?? 1 }}
        >
          {isVideo ? (
            <video
              src={mediaSrc}
              className="block w-full h-auto"
              muted
              playsInline
              preload="metadata"
              onError={onMediaError}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                if (v.videoWidth && v.videoHeight) {
                  setRatio(v.videoWidth / v.videoHeight)
                }
              }}
            />
          ) : (
            <img
              src={mediaSrc}
              alt={item.title}
              className="block w-full h-auto"
              loading="lazy"
              onError={onMediaError}
              onLoad={(e) => {
                const img = e.currentTarget
                if (img.naturalWidth && img.naturalHeight) {
                  setRatio(img.naturalWidth / img.naturalHeight)
                }
              }}
            />
          )}
        </div>
        <div className="p-4 flex items-center justify-between gap-2">
          <p className="text-base font-medium leading-tight truncate">
            {item.title}
          </p>
          {pinStatus && <TokenPinStatus status={pinStatus} />}
        </div>
      </Link>
      {isOwner && item.buyPrice && (
        <BuyPriceSection
          nftContract={item.contract}
          tokenId={item.tokenId}
          buyPrice={item.buyPrice}
        />
      )}
    </div>
  )
}

function BuyPriceSection({
  nftContract,
  tokenId,
  buyPrice,
}: {
  nftContract: string
  tokenId: string
  buyPrice: { seller: string; price: string }
}) {
  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
  } = useWriteContract()

  const { isLoading: isTxPending, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  // Optimistic hide once the cancel tx confirms; a refetch of the page would
  // also clear it, but the user closes the gap immediately.
  if (isSuccess) return null

  function handleCancel() {
    writeContract({
      address: MARKET_ADDRESS,
      abi: nftMarketAbi,
      functionName: "cancelBuyPrice",
      args: [nftContract as `0x${string}`, BigInt(tokenId)],
    })
  }

  const isPending = isWritePending || isTxPending
  const priceWei = BigInt(buyPrice.price)

  return (
    <div className="px-4 pb-4 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-500">Listed for</span>
        <span className="font-medium">{formatEther(priceWei)} ETH</span>
      </div>
      <button
        onClick={handleCancel}
        disabled={isPending}
        className="w-full text-xs font-medium py-2 border border-gray-200 rounded hover:border-gray-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isWritePending
          ? "Confirm in wallet..."
          : isTxPending
            ? "Canceling..."
            : "Cancel Listing"}
      </button>
      {writeError && (
        <p className="text-xs text-red-500 truncate">
          {writeError.message.includes("User rejected")
            ? "Transaction rejected"
            : "Failed to cancel"}
        </p>
      )}
    </div>
  )
}
