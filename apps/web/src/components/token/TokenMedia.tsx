"use client"

import { useEffect, useRef, useState } from "react"
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
  posterUrl,
  mediaKind,
  title,
}: {
  imageUrl: string
  animationUrl?: string | null
  posterUrl?: string | null
  mediaKind?: "image" | "video" | "animation" | "unknown" | null
  title: string
}) {
  // Prefer animation_url when present — it's the dynamic version of the
  // work. Fall back to imageUrl for the static-image case. HTML rendering
  // is only allowed via animation_url so a poster-less imageUrl doesn't
  // accidentally end up in an iframe.
  const useAnimation = !!animationUrl
  const renderUrl = useAnimation ? animationUrl! : imageUrl
  const classified = classify(renderUrl, useAnimation)
  const initialKind: MediaKind = mediaKind === "video" ? "video" : classified.kind
  const ambiguous = mediaKind == null || mediaKind === "unknown"
    ? classified.ambiguous
    : false

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
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [videoVisible, setVideoVisible] = useState(false)
  const [videoLoaded, setVideoLoaded] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video || kind !== "video") return
    const observer = new IntersectionObserver(
      ([entry]) => setVideoVisible(entry?.isIntersecting === true),
      { rootMargin: "200px 0px", threshold: 0.05 },
    )
    observer.observe(video)
    return () => observer.disconnect()
  }, [kind])

  useEffect(() => {
    if (kind !== "image" || !ambiguous || escalated) return
    // A few metadata providers return extension-less MP4 URLs in `image`.
    // Safari can leave those as a permanently broken image without reliably
    // firing onError. Check the decoded state after the request settles and
    // switch to the video renderer when no image was produced.
    const timer = window.setTimeout(() => {
      const image = imageRef.current
      if (image?.complete && image.naturalWidth === 0) setEscalated(true)
    }, 2500)
    return () => window.clearTimeout(timer)
  }, [ambiguous, escalated, kind, media.src])

  useEffect(() => {
    const video = videoRef.current
    if (!video || kind !== "video" || videoFailed) return
    if (videoVisible) {
      void video.play().catch(() => {
        // Autoplay policy may require a gesture; controls remain available.
      })
    } else {
      video.pause()
    }
  }, [kind, videoVisible, videoFailed])

  function handleImageError() {
    // Rotate to the next gateway first; only once every gateway has failed
    // do we conclude this isn't a loadable image and try it as a video.
    if (media.onError()) return
    if (ambiguous && !escalated) setEscalated(true)
  }

  if (!imageUrl && !animationUrl) {
    return (
      <div className="flex aspect-square min-h-48 min-w-48 items-center justify-center border border-gray-300 px-6 text-center text-xs font-mono text-fg-muted">
        Media is not indexed for this token yet.
      </div>
    )
  }

  if (kind === "video") {
    const v = escalated ? escalatedVideo : media
    const resolvedPoster =
      posterUrl ?? (useAnimation && imageUrl !== renderUrl ? poster : undefined)
    function handleVideoError() {
      setVideoLoaded(false)
      if (!v.onError()) setVideoFailed(true)
    }
    return (
      <div className="relative flex min-h-48 max-h-[80vh] min-w-48 items-center justify-center bg-black text-white">
        <video
          ref={videoRef}
          src={videoVisible && !videoFailed ? v.src : undefined}
          poster={resolvedPoster}
          className={`max-h-[80vh] w-auto object-contain ${videoLoaded || resolvedPoster ? "opacity-100" : "opacity-0"}`}
          preload={videoVisible ? "metadata" : "none"}
          loop
          muted
          playsInline
          controls
          onLoadedData={() => setVideoLoaded(true)}
          onError={handleVideoError}
        />
        {!videoLoaded ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 px-6 text-center text-xs font-mono">
            <span>
              {videoFailed
                ? "Video could not be loaded. The original source is still available."
                : resolvedPoster
                  ? "Loading video metadata…"
                  : "Video preview has no poster. Loading starts when visible."}
            </span>
            {videoFailed ? (
              <button
                type="button"
                className="border border-white/60 px-2 py-1 hover:border-white"
                onClick={() => {
                  setVideoFailed(false)
                  setVideoLoaded(false)
                  videoRef.current?.load()
                }}
              >
                Retry
              </button>
            ) : null}
            <a
              href={v.src}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Open original media ↗
            </a>
          </div>
        ) : null}
      </div>
    )
  }

  if (kind === "html") {
    // HTML animation_url is on-chain interactive art. Sandbox blocks the
    // iframe from same-origin access (no parent DOM, no cookies) but lets
    // its own scripts run — the standard pattern OpenSea/Zora use. The
    // viewer has no idea what aspect ratio the art expects, so default to
    // square scaled to viewport. allow="autoplay" delegates the autoplay
    // Permissions Policy so a work with sound can start audio (still subject
    // to the browser's gesture requirement — most works start on a click).
    // Sound is the work's own to control: these documents carry their own
    // play surface, and a second control over the top of it competes with
    // whatever the artist built.
    return (
      <iframe
        src={media.src}
        title={title}
        sandbox="allow-scripts"
        allow="autoplay"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="aspect-square h-[80vh] max-h-[80vh] max-w-full bg-black"
      />
    )
  }

  return (
    <img
      ref={imageRef}
      src={media.src}
      alt={title}
      className="max-h-[80vh] w-auto object-contain"
      onError={handleImageError}
    />
  )
}
