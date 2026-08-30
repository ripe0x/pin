"use client"

import { AddressZorb } from "@/components/AddressZorb"
import { useThumbnailMedia } from "@/lib/use-thumbnail-media"

type Props = {
  src: string | null
  alt: string
  fallbackAddress: string
  mediaKind?: string | null
}

/**
 * Availability cards must never turn failed delivery media into an empty gray
 * billboard. Exhaust the normal optimized/raw/gateway cascade, then retain a
 * real identity signal by rendering the seller or collection owner's zorb.
 */
export function AvailableArtwork({ src, alt, fallbackAddress, mediaKind }: Props) {
  const media = useThumbnailMedia(src ?? "", 720, mediaKind)

  if (!src || media.kind === "failed") {
    return (
      <AddressZorb
        address={fallbackAddress}
        alt={`${alt} preview unavailable; artist identity shown`}
        className="h-full w-full"
      />
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
