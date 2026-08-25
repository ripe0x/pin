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

type MediaKind = "video" | "image" | "html"

function extOf(url: string): string {
  const path = url.split("?")[0].split("#")[0].toLowerCase()
  const dot = path.lastIndexOf(".")
  const slash = path.lastIndexOf("/")
  return dot > slash ? path.slice(dot) : ""
}

function classify(
  url: string,
  allowHtml: boolean,
): { kind: MediaKind; ambiguous: boolean } {
  const ext = extOf(url)
  if (VIDEO_EXTENSIONS.includes(ext)) return { kind: "video", ambiguous: false }
  if (IMAGE_EXTENSIONS.includes(ext)) return { kind: "image", ambiguous: false }
  // Unknown extension. An animation_url with no extension is almost always
  // an HTML page (interactive on-chain art), so iframe it; a bare image is
  // just an image to render. The bare-image guess is fragile — see escalation.
  return { kind: allowHtml ? "html" : "image", ambiguous: true }
}

/**
 * Centered media renderer for the auction detail page. Mirrors PND's
 * `apps/web/src/components/token/TokenMedia.tsx`: max-h-80vh, w-auto,
 * object-contain — so the artwork dominates the viewport without spilling
 * out of the sticky column it sits in.
 *
 * Prefers `animation_url` (the dynamic version: video or HTML art) over the
 * static `image`. Some tokens stuff a video into the `image` field with no
 * animation_url and no file extension, so an extension-less image that fails
 * to load is escalated to a <video> rather than left as a broken <img>.
 */
export function TokenMedia({
  image,
  animationUrl,
  title,
}: {
  image: string | null
  animationUrl?: string | null
  title: string
}) {
  const [escalated, setEscalated] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const loadFinished = useRef(false)

  const useAnimation = !!animationUrl
  const renderUrl = useAnimation ? animationUrl! : image
  // Rotate IPFS/Arweave gateways on load error before giving up. A fresh
  // arweave.net bundle can 404 while another gateway already serves it.
  const media = useMediaFallback(renderUrl)
  const classification = renderUrl
    ? classify(renderUrl, useAnimation)
    : { kind: "image" as MediaKind, ambiguous: false }
  const kind: MediaKind = escalated ? "video" : classification.kind

  useEffect(() => setHydrated(true), [])

  // Recover image/video failures that fired before this component hydrated,
  // then apply the same hang timeout to every media kind.
  useEffect(() => {
    loadFinished.current = false
    const img = imageRef.current
    const video = videoRef.current
    const frame = frameRef.current
    if (img?.complete) {
      if (img.naturalWidth > 0) loadFinished.current = true
      else media.onError()
    }
    if (video) {
      if (video.readyState >= 1) loadFinished.current = true
      else if (video.error) media.onError()
    }

    const element = img ?? video ?? frame
    if (!element || typeof IntersectionObserver === "undefined") return

    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        fallbackTimer = setTimeout(() => {
          if (!loadFinished.current) media.onError()
        }, 7_000)
      },
      { rootMargin: "400px" },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (fallbackTimer) clearTimeout(fallbackTimer)
    }
    // Restart the timeout for each rotated gateway URL / media kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, kind, media.src])

  if (!renderUrl) {
    return (
      <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400">
        No preview
      </div>
    )
  }

  const { ambiguous } = classification
  const src = media.src ?? renderUrl

  if (kind === "video") {
    return (
      <video
        ref={videoRef}
        src={src}
        poster={useAnimation && image ? image : undefined}
        className="max-h-[80vh] w-auto object-contain"
        autoPlay
        loop
        muted
        playsInline
        controls
        onLoadedMetadata={() => {
          loadFinished.current = true
        }}
        onError={() => {
          media.onError()
        }}
      />
    )
  }

  if (kind === "html") {
    // Sandbox blocks same-origin access (no parent DOM, no cookies) but lets
    // the art's own scripts run — the standard OpenSea/Zora pattern. The
    // viewer can't know the intended aspect ratio, so default to square.
    if (!hydrated) {
      return <div className="aspect-square h-[80vh] max-h-[80vh] max-w-full bg-black" />
    }
    return (
      <iframe
        ref={frameRef}
        src={src}
        title={title}
        sandbox="allow-scripts"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="aspect-square h-[80vh] max-h-[80vh] max-w-full bg-black"
        onLoad={() => {
          loadFinished.current = true
        }}
      />
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imageRef}
      src={src}
      alt={title}
      className="max-h-[80vh] w-auto object-contain"
      onLoad={() => {
        loadFinished.current = true
      }}
      onError={() => {
        // Rotate gateways first; only once they're exhausted treat an
        // extension-less image as a misclassified video.
        if (media.onError()) return
        if (ambiguous && !escalated) setEscalated(true)
      }}
    />
  )
}
