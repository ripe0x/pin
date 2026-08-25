"use client"

import { useEffect, useRef, useState } from "react"
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
  const imageRef = useRef<HTMLImageElement>(null)
  const recoveredMissedError = useRef(false)
  // Rotate IPFS/Arweave gateways on load error before escalating.
  const media = useMediaFallback(src)
  // A fast gateway failure can happen before React hydrates, so its native
  // error event never reaches onError. Detect that already-failed image once
  // hydration completes and start the normal gateway rotation ourselves.
  useEffect(() => {
    if (recoveredMissedError.current) return
    recoveredMissedError.current = true
    const img = imageRef.current
    if (img?.complete && img.naturalWidth === 0) media.onError()
    // This is specifically the one-time hydration check. Later failures are
    // handled by the element's onError callback below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A gateway can also hang without firing an error. Once this lazy image is
  // near the viewport, give each candidate seven seconds to produce usable
  // dimensions before advancing to the next gateway.
  useEffect(() => {
    const img = imageRef.current
    if (!img || typeof IntersectionObserver === "undefined") return

    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        fallbackTimer = setTimeout(() => {
          if (!img.complete || img.naturalWidth === 0) media.onError()
        }, 7_000)
      },
      { rootMargin: "400px" },
    )
    observer.observe(img)
    return () => {
      observer.disconnect()
      if (fallbackTimer) clearTimeout(fallbackTimer)
    }
    // Restart the timeout for each rotated gateway URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.src])
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
          ref={imageRef}
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
