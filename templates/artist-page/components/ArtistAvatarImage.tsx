"use client"

import { useEffect, useRef } from "react"
import { useMediaFallback } from "@/lib/use-media-fallback"

export function ArtistAvatarImage({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  className?: string
}) {
  const imageRef = useRef<HTMLImageElement>(null)
  const media = useMediaFallback(src)

  useEffect(() => {
    const image = imageRef.current
    if (!image) return
    if (image.complete && image.naturalWidth === 0) media.onError()

    const timer = setTimeout(() => {
      if (!image.complete || image.naturalWidth === 0) media.onError()
    }, 7_000)
    return () => clearTimeout(timer)
  }, [media.src]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imageRef}
      src={media.src ?? src}
      alt={alt}
      className={className}
      onError={() => media.onError()}
    />
  )
}
