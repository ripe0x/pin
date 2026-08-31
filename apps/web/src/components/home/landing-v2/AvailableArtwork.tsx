"use client"

import { useEffect, useState } from "react"
import { useThumbnailMedia } from "@/lib/use-thumbnail-media"

type Props = {
  src: string | null
  alt: string
  mediaKind?: string | null
}

/** Exhaust every media fallback without flashing native broken-image chrome. */
export function AvailableArtwork({ src, alt, mediaKind }: Props) {
  const media = useThumbnailMedia(src ?? "", 720, mediaKind)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setLoaded(false)
  }, [src, media.kind, media.imgSrc, media.videoSrc])

  if (!src || media.kind === "failed") {
    return (
      <div
        role="img"
        aria-label={`${alt} preview unavailable`}
        className="h-full w-full bg-gray-100"
      />
    )
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-gray-100">
      {media.kind === "video" ? (
        <video
          src={media.videoSrc}
          aria-label={alt}
          muted
          playsInline
          preload="metadata"
          onError={() => {
            setLoaded(false)
            media.onVideoError()
          }}
          onLoadedData={() => setLoaded(true)}
          className={`h-full w-full object-cover transition-[opacity,transform] duration-500 group-hover:scale-[1.015] ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={media.imgRef}
          src={media.imgSrc}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => {
            setLoaded(false)
            media.onImgError()
          }}
          onLoad={() => setLoaded(true)}
          className={`h-full w-full object-cover transition-[opacity,transform] duration-500 group-hover:scale-[1.015] ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      {!loaded ? <div aria-hidden className="skeleton absolute inset-0" /> : null}
    </div>
  )
}
