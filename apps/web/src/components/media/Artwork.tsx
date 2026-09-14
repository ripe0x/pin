"use client"

import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react"
import { useIpfsGatewayFallback } from "@/lib/use-ipfs-fallback"
import { useThumbnailMedia } from "@/lib/use-thumbnail-media"
import type { DisplayMedia } from "@/lib/display-media"

type Props = {
  media: DisplayMedia
  alt: string
  className?: string
}

/**
 * Renders a `DisplayMedia` resolved server-side by `getDisplayMedia`.
 *
 * image: `<img>` through the proxy-resize and gateway-rotation cascade.
 * A URL with no file extension can turn out to be a video (some CDNs
 * serve mp4 from the metadata `image` field); when the image cascade
 * fails on such a URL the element escalates to a video still.
 * video with poster: the poster as an `<img>` with a play glyph.
 * video without poster: a paused first frame from the video itself.
 * none: a labelled placeholder.
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
  const media = useThumbnailMedia(src, 720)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setLoaded(false)
    // A cached image can finish before React attaches onLoad. Read the
    // element state once on mount so a loaded image never keeps the
    // skeleton.
    if (media.imgRef.current?.complete && media.imgRef.current.naturalWidth > 0) {
      setLoaded(true)
    }
  }, [src, media.imgSrc])

  if (media.kind === "failed") return <Placeholder alt={alt} className={className} />
  if (media.kind === "video") {
    return (
      <VideoStill
        src={media.videoSrc}
        alt={alt}
        className={className}
        onSourceError={() => {
          // The escalated cascade reports whether it rotated; the plain
          // image cascade returns nothing and tracks failure itself.
          const rotated = media.onVideoError() as unknown
          return rotated === undefined ? true : rotated === true
        }}
      />
    )
  }

  return (
    <div className={cx("relative h-full w-full overflow-hidden bg-gray-100", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={media.imgRef}
        src={media.imgSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={media.onImgError}
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

/** Video without a stored poster, with gateway rotation on its source. */
function VideoArtwork({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const { src: videoSrc, onError } = useIpfsGatewayFallback(src)
  return <VideoStill src={videoSrc} alt={alt} className={className} onSourceError={onError} />
}

/**
 * A still frame taken from the video itself. The element autoplays muted
 * and pauses on the first playing frame, which paints a frame in every
 * browser (Safari paints nothing for a paused video that never played)
 * while downloading only the head of the file. `onSourceError` returns
 * true when it swapped in another source; false means give up.
 */
function VideoStill({
  src,
  alt,
  className,
  onSourceError,
}: {
  src: string
  alt: string
  className?: string
  onSourceError: () => boolean
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    setLoaded(false)
    setFailed(false)
    const video = videoRef.current
    if (!video) return
    if (video.readyState >= 2) setLoaded(true)
    // Reload after a source swap; autoplay only fires on the initial load.
    video.load()
  }, [src])

  const holdFirstFrame = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    video.pause()
    setLoaded(true)
  }

  if (failed) return <Placeholder alt={alt} className={className} />

  return (
    <div className={cx("relative h-full w-full overflow-hidden bg-gray-100", className)}>
      <video
        ref={videoRef}
        src={src}
        aria-label={alt}
        autoPlay
        muted
        playsInline
        disablePictureInPicture
        preload="metadata"
        onPlaying={holdFirstFrame}
        onLoadedData={() => setLoaded(true)}
        onError={() => {
          setLoaded(false)
          if (!onSourceError()) setFailed(true)
        }}
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
