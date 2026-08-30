"use client"

import { AddressZorb } from "@/components/AddressZorb"
import { useOptimizedImage } from "@/lib/use-optimized-image"

type Props = {
  src: string | null
  alt: string
  fallbackAddress: string
}

/**
 * Availability cards must never turn failed delivery media into an empty gray
 * billboard. Exhaust the normal optimized/raw/gateway cascade, then retain a
 * real identity signal by rendering the seller or collection owner's zorb.
 */
export function AvailableArtwork({ src, alt, fallbackAddress }: Props) {
  const optimized = useOptimizedImage(src ?? "", 720)

  if (!src || optimized.failed) {
    return (
      <AddressZorb
        address={fallbackAddress}
        alt={`${alt} preview unavailable; artist identity shown`}
        className="h-full w-full"
      />
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={optimized.ref}
      src={optimized.src}
      alt={alt}
      loading="lazy"
      onError={optimized.onError}
      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.015]"
    />
  )
}
