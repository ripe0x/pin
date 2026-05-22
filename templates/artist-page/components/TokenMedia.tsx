"use client"

import { useState } from "react"

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
  // Unknown extension. An animation_url with no extension is almost always
  // an HTML page (interactive on-chain art), so iframe it; a bare image is
  // just an image to render. The bare-image guess is fragile — see escalation.
  return { kind: allowHtml ? "html" : "image", ambiguous: true }
}

/**
 * Centered media renderer for the auction detail page. Mirrors PND's
 * `apps/web/src/components/token/TokenMedia.tsx`: max-h-80vh, w-auto,
 * object-contain — so the artwork dominates the viewport without spilling
 * out of the sticky column it sits in.
 *
 * Prefers `animation_url` (the dynamic version: video or HTML art) over the
 * static `image`. Some tokens stuff a video into the `image` field with no
 * animation_url and no file extension, so an extension-less image that fails
 * to load is escalated to a <video> rather than left as a broken <img>.
 */
export function TokenMedia({
  image,
  animationUrl,
  title,
}: {
  image: string | null
  animationUrl?: string | null
  title: string
}) {
  const [escalated, setEscalated] = useState(false)

  const useAnimation = !!animationUrl
  const renderUrl = useAnimation ? animationUrl! : image

  if (!renderUrl) {
    return (
      <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400">
        No preview
      </div>
    )
  }

  const { kind: initialKind, ambiguous } = classify(renderUrl, useAnimation)
  const kind: MediaKind = escalated ? "video" : initialKind

  if (kind === "video") {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        src={renderUrl}
        poster={useAnimation && image ? image : undefined}
        className="max-h-[80vh] w-auto object-contain"
        autoPlay
        loop
        muted
        playsInline
        controls
      />
    )
  }

  if (kind === "html") {
    // Sandbox blocks same-origin access (no parent DOM, no cookies) but lets
    // the art's own scripts run — the standard OpenSea/Zora pattern. The
    // viewer can't know the intended aspect ratio, so default to square.
    return (
      <iframe
        src={renderUrl}
        title={title}
        sandbox="allow-scripts"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="aspect-square h-[80vh] max-h-[80vh] max-w-full bg-black"
      />
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={renderUrl}
      alt={title}
      className="max-h-[80vh] w-auto object-contain"
      onError={() => {
        if (ambiguous && !escalated) setEscalated(true)
      }}
    />
  )
}
