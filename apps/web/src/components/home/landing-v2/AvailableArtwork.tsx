"use client"

import { useThumbnailMedia } from "@/lib/use-thumbnail-media"

type Props = {
  src: string | null
  alt: string
  mediaKind?: string | null
}

/**
 * Availability cards must never turn failed delivery media into an empty gray
 * billboard. Exhaust the normal optimized/raw/gateway cascade, then label the
 * missing preview explicitly so an identity graphic is never mistaken for art.
 */
export function AvailableArtwork({ src, alt, mediaKind }: Props) {
  const media = useThumbnailMedia(src ?? "", 720, mediaKind)

  if (!src || media.kind === "failed") {
    return (
      <div
        role="img"
        aria-label={`${alt} preview unavailable`}
        className="flex h-full w-full items-center justify-center px-4 text-center text-[10px] font-mono leading-relaxed text-fg-muted"
      >
        Artwork preview unavailable
      </div>
    )
  }

  if (media.kind === "video") {
    return (
      <video
        src={media.videoSrc}
        aria-label={alt}
        muted
        playsInline
        preload="metadata"
        onError={media.onVideoError}
        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.015]"
      />
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={media.imgRef}
      src={media.imgSrc}
      alt={alt}
      loading="lazy"
      onError={media.onImgError}
      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.015]"
    />
  )
}
