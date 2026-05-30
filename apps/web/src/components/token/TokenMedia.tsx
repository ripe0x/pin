"use client"

import { useState } from "react"
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

function classify(
  url: string,
  allowHtml: boolean,
): { kind: MediaKind; ambiguous: boolean } {
  const ext = extOf(url)
  if (VIDEO_EXTENSIONS.includes(ext)) return { kind: "video", ambiguous: false }
  if (IMAGE_EXTENSIONS.includes(ext)) return { kind: "image", ambiguous: false }
  // Unknown extension. For animation_url this is almost always an HTML
  // page or an IPFS directory pointer, so iframe it; for a bare imageUrl
  // (including the placeholder fallback) it's just an image to render.
  // The bare-image guess is fragile — see the escalation note below.
  return { kind: allowHtml ? "html" : "image", ambiguous: true }
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
  const { kind: initialKind, ambiguous } = classify(renderUrl, useAnimation)

  // Some tokens stuff a video into the `image` field with no animation_url
  // and no file extension — e.g. uri() => {"image":"ipfs://<mp4 cid>"}. That
  // classifies as an image and renders a broken <img>. If the image fails to
  // load across *every* gateway, escalate to <video> before giving up. Only
  // for the ambiguous (extension-less) case, so real images that 404 on one
  // gateway still rotate through the rest as images.
  const [escalated, setEscalated] = useState(false)
  const kind: MediaKind = escalated ? "video" : initialKind

  const media = useIpfsGatewayFallback(renderUrl)
  // Fresh gateway cascade for the escalated <video>, since `media` is
  // exhausted by the time we escalate.
  const escalatedVideo = useIpfsGatewayFallback(renderUrl)
  // Poster is only used by the (non-escalated) video branch; computing it
  // unconditionally keeps hook order stable.
  const poster = useIpfsGatewayFallback(imageUrl).src

  function handleImageError() {
    // Rotate to the next gateway first; only once every gateway has failed
    // do we conclude this isn't a loadable image and try it as a video.
    if (media.onError()) return
    if (ambiguous && !escalated) setEscalated(true)
  }

  if (kind === "video") {
    const v = escalated ? escalatedVideo : media
    return (
      <video
        src={v.src}
        poster={useAnimation ? poster : undefined}
        className="max-h-[80vh] w-auto object-contain"
        autoPlay
        loop
        muted
        playsInline
        controls
        onError={v.onError}
      />
    )
  }

  if (kind === "html") {
    // HTML animation_url is on-chain interactive art (e.g. Mint protocol's
    // gzip-packed p5 sketches). Sandbox blocks the iframe from same-origin
    // access (no parent DOM, no cookies) but lets its own scripts run — the
    // standard pattern OpenSea/Zora use.
    //
    // Size with EXPLICIT width + height. An iframe has no intrinsic content
    // size, so `aspect-square h-[80vh]` (the previous sizing) collapsed to
    // 0×0 as a flex child — the art ran but had no box to paint into, so the
    // `bg-black` fill showed as a black canvas. Pinning both dimensions to
    // 80vh keeps it square on desktop; `max-w-full` lets it shrink to fit a
    // narrow viewport (the art canvas self-centers inside).
    return (
      <iframe
        src={media.src}
        title={title}
        sandbox="allow-scripts"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="h-[80vh] w-[80vh] max-h-[80vh] max-w-full bg-black"
      />
    )
  }

  return (
    <img
      src={media.src}
      alt={title}
      className="max-h-[80vh] w-auto object-contain"
      onError={handleImageError}
    />
  )
}
