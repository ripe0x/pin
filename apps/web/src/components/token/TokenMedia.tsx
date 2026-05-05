"use client"

import { useIpfsGatewayFallback } from "@/lib/use-ipfs-fallback"

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

function classify(url: string, allowHtml: boolean): MediaKind {
  const ext = extOf(url)
  if (VIDEO_EXTENSIONS.includes(ext)) return "video"
  if (IMAGE_EXTENSIONS.includes(ext)) return "image"
  // Unknown extension. For animation_url this is almost always an HTML
  // page or an IPFS directory pointer, so iframe it; for a bare imageUrl
  // (including the placeholder fallback) it's just an image to render.
  return allowHtml ? "html" : "image"
}

export function TokenMedia({
  imageUrl,
  animationUrl,
  title,
}: {
  imageUrl: string
  animationUrl?: string | null
  title: string
}) {
  // Prefer animation_url when present — it's the dynamic version of the
  // work. Fall back to imageUrl for the static-image case. HTML rendering
  // is only allowed via animation_url so a poster-less imageUrl doesn't
  // accidentally end up in an iframe.
  const useAnimation = !!animationUrl
  const renderUrl = useAnimation ? animationUrl! : imageUrl
  const kind: MediaKind = classify(renderUrl, useAnimation)

  const { src, onError } = useIpfsGatewayFallback(renderUrl)
  // Poster is only used by the video branch; computing it unconditionally
  // keeps hook order stable.
  const poster = useIpfsGatewayFallback(imageUrl).src

  if (kind === "video") {
    return (
      <video
        src={src}
        poster={useAnimation ? poster : undefined}
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

  if (kind === "html") {
    // HTML animation_url is on-chain interactive art. Sandbox blocks the
    // iframe from same-origin access (no parent DOM, no cookies) but lets
    // its own scripts run — the standard pattern OpenSea/Zora use. The
    // viewer has no idea what aspect ratio the art expects, so default to
    // square scaled to viewport.
    return (
      <iframe
        src={src}
        title={title}
        sandbox="allow-scripts"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="aspect-square h-[80vh] max-h-[80vh] max-w-full bg-black"
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
