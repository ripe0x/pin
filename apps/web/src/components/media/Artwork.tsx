"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useOptimizedImage } from "@/lib/use-optimized-image"
import { useIpfsGatewayFallback } from "@/lib/use-ipfs-fallback"
import type { DisplayMedia } from "@/lib/display-media"

type Props = {
  media: DisplayMedia
  alt: string
  className?: string
}

/**
 * Renders a `DisplayMedia` resolved server-side by `getDisplayMedia`.
 * Image and video-with-poster both render an `<img>` through the same
 * proxy-resize + gateway-rotation cascade `useOptimizedImage` already
 * gives every other grid thumbnail; video-without-poster falls back to a
 * native `<video>` element with its own gateway rotation.
 */
export function Artwork({ media, alt, className }: Props) {
  if (media.kind === "none") return <Placeholder alt={alt} className={className} />
  if (media.kind === "image") return <ImageArtwork src={media.src} alt={alt} className={className} />
  if (media.poster) {
    return <ImageArtwork src={media.poster} alt={alt} className={className} overlay={<PlayGlyph />} />
  }
  return <VideoArtwork src={media.src} alt={alt} className={className} />
}

function Placeholder({ alt, className }: { alt: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label={`${alt} preview unavailable`}
      className={cx("h-full w-full bg-gray-100", className)}
    />
  )
}

/** Image, or a video's stored poster shown as a still with an overlay
 * (e.g. a play glyph). Both go through the same proxy/gateway cascade. */
function ImageArtwork({
  src,
  alt,
  className,
  overlay,
}: {
  src: string
  alt: string
  className?: string
  overlay?: ReactNode
}) {
  const img = useOptimizedImage(src, 720)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setLoaded(false)
    // Cached media can finish before React hydrates and attaches onLoad.
    // Recover that success state so a real image never sits behind the
    // loading skeleton forever.
    if (img.ref.current?.complete && img.ref.current.naturalWidth > 0) {
      setLoaded(true)
    }
  }, [src, img.src])

  if (img.failed) return <Placeholder alt={alt} className={className} />

  return (
    <div className={cx("relative h-full w-full overflow-hidden bg-gray-100", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={img.ref}
        src={img.src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={img.onError}
        onLoad={() => setLoaded(true)}
        className={`h-full w-full object-cover transition-[opacity,transform] duration-500 group-hover:scale-[1.015] ${
          loaded ? "" : "animate-pulse"
        }`}
      />
      {!loaded ? <div aria-hidden className="skeleton absolute inset-0" /> : null}
      {overlay}
    </div>
  )
}

/** Video with no stored poster: a native <video> element with its own
 * gateway rotation, first frame as the still. Never an empty gray box. */
function VideoArtwork({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const { src: videoSrc, onError } = useIpfsGatewayFallback(src)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    setLoaded(false)
    if ((videoRef.current?.readyState ?? 0) >= 2) setLoaded(true)
  }, [src, videoSrc])

  if (failed) return <Placeholder alt={alt} className={className} />

  return (
    <div className={cx("relative h-full w-full overflow-hidden bg-gray-100", className)}>
      <video
        ref={videoRef}
        src={videoSrc}
        aria-label={alt}
        muted
        playsInline
        preload="metadata"
        onError={() => {
          setLoaded(false)
          if (!onError()) setFailed(true)
        }}
        onLoadedData={() => setLoaded(true)}
        className={`h-full w-full object-cover transition-[opacity,transform] duration-500 group-hover:scale-[1.015] ${
          loaded ? "" : "animate-pulse"
        }`}
      />
      {!loaded ? <div aria-hidden className="skeleton absolute inset-0" /> : null}
      <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-white">
        Video
      </span>
    </div>
  )
}

function PlayGlyph() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white">
        <svg viewBox="0 0 16 16" className="ml-0.5 h-4 w-4 fill-current">
          <path d="M4 2.5v11l10-5.5z" />
        </svg>
      </span>
    </span>
  )
}

function cx(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(" ")
}
