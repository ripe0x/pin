"use client"

import { useState } from "react"
import { useMediaFallback } from "@/lib/use-media-fallback"

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]
const IMAGE_EXTENSIONS = [
  ".gif",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
]

function extOf(url: string): string {
  const path = url.split("?")[0].split("#")[0].toLowerCase()
  const dot = path.lastIndexOf(".")
  const slash = path.lastIndexOf("/")
  return dot > slash ? path.slice(dot) : ""
}

/**
 * Image / video container that adopts the media's intrinsic aspect ratio
 * once it loads — same pattern as PND's `GalleryCard`. Pre-load it shows
 * a square box (default 1:1) so the masonry layout has something to
 * stack while the natural ratio is still unknown.
 *
 * Client component because it uses `naturalWidth`/`videoWidth` which are
 * only meaningful after the asset has loaded in the browser.
 */
export function AuctionCardImage({
  src,
  alt,
}: {
  src: string | null
  alt: string
}) {
  const [ratio, setRatio] = useState<number | null>(null)
  // Cards stick with the static image. The one exception is a token that
  // stuffs a video into the `image` field with no extension — there's no
  // real image to show, so an extension-less <img> that fails to load is
  // escalated to <video>.
  const [escalated, setEscalated] = useState(false)
  // Rotate IPFS/Arweave gateways on load error before escalating.
  const media = useMediaFallback(src)
  if (!src) {
    return (
      <div
        className="relative overflow-hidden bg-gray-100 flex items-center justify-center text-[10px] font-mono uppercase tracking-wider text-gray-400"
        style={{ aspectRatio: 1 }}
      >
        No preview
      </div>
    )
  }
  const ext = extOf(src)
  const ambiguous = !VIDEO_EXTENSIONS.includes(ext) && !IMAGE_EXTENSIONS.includes(ext)
  const video = VIDEO_EXTENSIONS.includes(ext) || escalated
  const url = media.src ?? src
  return (
    <div
      className="relative overflow-hidden bg-gray-100"
      style={{ aspectRatio: ratio ?? 1 }}
    >
      {video ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={url}
          className="block w-full h-auto"
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            if (v.videoWidth && v.videoHeight) {
              setRatio(v.videoWidth / v.videoHeight)
            }
          }}
          onError={() => {
            media.onError()
          }}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={alt}
          className="block w-full h-auto"
          loading="lazy"
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth && img.naturalHeight) {
              setRatio(img.naturalWidth / img.naturalHeight)
            }
          }}
          onError={() => {
            // Rotate gateways first; only then treat an extension-less
            // image as a misclassified video.
            if (media.onError()) return
            if (ambiguous && !escalated) setEscalated(true)
          }}
        />
      )}
    </div>
  )
}
