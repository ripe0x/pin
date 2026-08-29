"use client"

import { useEffect, useRef, useState } from "react"
import { AddressZorb } from "@/components/AddressZorb"
import { useIpfsGatewayFallback } from "@/lib/use-ipfs-fallback"

export function IdentityAvatar({
  address,
  avatarUrl,
  alt = "",
  className,
}: {
  address: string
  avatarUrl: string | null
  alt?: string
  className?: string
}) {
  const media = useIpfsGatewayFallback(avatarUrl ?? "")
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [failed, setFailed] = useState(!avatarUrl)

  function handleError() {
    if (!media.onError()) setFailed(true)
  }

  // An SSR image can fail before React attaches onError. Replace it with the
  // deterministic address avatar instead of leaving a broken image glyph.
  useEffect(() => {
    const image = imageRef.current
    if (image?.complete && image.naturalWidth === 0) handleError()
  }, [media.src])

  if (failed || !avatarUrl) {
    return <AddressZorb address={address} alt={alt} className={className} />
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imageRef}
      src={media.src}
      alt={alt}
      className={className}
      onError={handleError}
    />
  )
}
