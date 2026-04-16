"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { createProvider, type PinStatus } from "@/lib/pinning"
import { TokenPinStatus } from "@/components/preserve/TokenPinStatus"

type GalleryItem = {
  contract: string
  tokenId: string
  title: string
  imageUrl: string
  creator: string
  metadataCid: string | null
  mediaCid: string | null
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

function isVideoUrl(url: string): boolean {
  const path = url.split("?")[0].toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))
}

export function ArtistGallery({ items }: { items: GalleryItem[] }) {
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

    // Collect unique CIDs to check
    const cids = new Set<string>()
    for (const item of items) {
      if (item.metadataCid) cids.add(item.metadataCid)
      if (item.mediaCid) cids.add(item.mediaCid)
    }

    // Check pin status for each CID
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
      setPinStatuses(statuses)
    }

    checkAll()
  }, [items])

  if (items.length === 0) {
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
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {items.map((item) => (
        <GalleryCard
          key={`${item.contract}:${item.tokenId}`}
          item={item}
          pinStatuses={pinStatuses}
          hasProvider={hasProvider}
        />
      ))}
    </div>
  )
}

function getItemPinStatus(
  item: GalleryItem,
  pinStatuses: Map<string, PinStatus>,
): PinStatus | null {
  // Consider an item pinned if its media CID is pinned (primary)
  // or its metadata CID is pinned (fallback)
  const mediaSt = item.mediaCid ? pinStatuses.get(item.mediaCid) : undefined
  const metaSt = item.metadataCid
    ? pinStatuses.get(item.metadataCid)
    : undefined

  if (mediaSt === "pinned" || mediaSt === "queued") return "pinned"
  if (metaSt === "pinned" || metaSt === "queued") return "pinned"

  // If we checked and neither is pinned
  if (mediaSt || metaSt) return "unknown"

  return null // not checked yet
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
  const isVideo = isVideoUrl(item.imageUrl)
  const pinStatus = hasProvider ? getItemPinStatus(item, pinStatuses) : null

  return (
    <Link
      href={href}
      className="group block border border-gray-200 transition-colors hover:border-gray-400"
    >
      <div className="relative overflow-hidden bg-gray-100 aspect-[4/5]">
        {isVideo ? (
          <video
            src={item.imageUrl}
            className="w-full h-full object-cover"
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <img
            src={item.imageUrl}
            alt={item.title}
            className="w-full h-full object-cover"
            loading="lazy"
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
  )
}
