"use client"

import { useIpfsGatewayFallback } from "@/lib/use-ipfs-fallback"

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

export function TokenMedia({ url, title }: { url: string; title: string }) {
  const path = url.split("?")[0].toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))
  const { src, onError } = useIpfsGatewayFallback(url)

  if (isVideo) {
    return (
      <video
        src={src}
        className="max-h-[80vh] w-auto object-contain"
        autoPlay
        loop
        muted
        playsInline
        controls
        onError={onError}
      />
    )
  }

  return (
    <img
      src={src}
      alt={title}
      className="max-h-[80vh] w-auto object-contain"
      onError={onError}
    />
  )
}
