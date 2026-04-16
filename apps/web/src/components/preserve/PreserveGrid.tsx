"use client"

import type { DiscoveredToken } from "@/lib/onchain-discovery"
import type { PinStatus } from "@/lib/pinning"
import { TokenPinStatus } from "./TokenPinStatus"

type TokenWithPinState = {
  token: DiscoveredToken
  metadataStatus: PinStatus
  mediaStatus: PinStatus
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

function isVideoUrl(url: string): boolean {
  const path = url.split("?")[0].toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))
}

export function PreserveGrid({ tokens }: { tokens: TokenWithPinState[] }) {
  if (tokens.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        No Foundation works found for this address.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      {tokens.map((item) => (
        <PreserveCard key={item.token.tokenId} item={item} />
      ))}
    </div>
  )
}

function PreserveCard({ item }: { item: TokenWithPinState }) {
  const { token, metadataStatus, mediaStatus } = item
  const imageUrl =
    token.mediaHttpUrl ??
    "https://placehold.co/400x500/F2F2F2/999999?text=NFT"
  const title = token.metadata?.name ?? `#${token.tokenId}`

  // Combined status: worst of the two
  const combinedStatus = worstStatus(metadataStatus, mediaStatus)

  const isVideo = isVideoUrl(imageUrl)

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="relative bg-gray-100 aspect-square">
        {isVideo ? (
          <video
            src={imageUrl}
            className="w-full h-full object-cover"
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <img
            src={imageUrl}
            alt={title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        )}
        {/* Pin status overlay */}
        <div className="absolute top-2 right-2">
          <TokenPinStatus status={combinedStatus} />
        </div>
      </div>
      <div className="p-3 space-y-1">
        <p className="text-sm font-medium truncate">{title}</p>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>Token #{token.tokenId}</span>
        </div>
      </div>
    </div>
  )
}

function worstStatus(a: PinStatus, b: PinStatus): PinStatus {
  const order: PinStatus[] = ["failed", "unknown", "queued", "pinning", "pinned"]
  const aIdx = order.indexOf(a)
  const bIdx = order.indexOf(b)
  return aIdx <= bIdx ? a : b
}
