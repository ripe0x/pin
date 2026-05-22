"use client"

import { useState } from "react"
import { useIpfsGatewayFallback } from "./use-ipfs-fallback"
import { useOptimizedImage } from "./use-optimized-image"
import { isAmbiguousMediaUrl, isVideoUrl } from "./media-url"

export type ThumbnailMediaKind = "image" | "video" | "failed"

/**
 * Drives a grid thumbnail that may be an image or a video. Wraps
 * `useOptimizedImage` and adds the same escalation TokenMedia uses on the
 * detail page: some tokens stuff a video into the `image` field with no
 * animation_url and no file extension, so the optimized <img> fails
 * across every gateway. When that happens on an extension-less
 * (ambiguous) URL, escalate to a <video> instead of leaving a broken
 * image. Real images that 404 on one gateway still rotate through the
 * rest as images first.
 */
export function useThumbnailMedia(url: string, width = 800) {
  const img = useOptimizedImage(url, width)
  // Fresh gateway cascade for the escalated <video> — the `img` cascade is
  // exhausted by the time we escalate.
  const escalatedVideo = useIpfsGatewayFallback(url)
  const [escalated, setEscalated] = useState(false)

  const knownVideo = isVideoUrl(url)
  const ambiguous = isAmbiguousMediaUrl(url)

  // Escalate once the image cascade is exhausted on an ambiguous URL.
  // Setting state during render (React-supported) re-renders immediately,
  // avoiding a flash of the broken/placeholder state.
  if (img.failed && ambiguous && !escalated) {
    setEscalated(true)
  }

  const kind: ThumbnailMediaKind =
    knownVideo || escalated ? "video" : img.failed ? "failed" : "image"

  // Known-extension video: reuse the optimized-image cascade (it passes
  // video URLs through unproxied). Escalated case: that cascade is spent,
  // so drive the video off the fresh gateway cascade.
  const videoSrc = escalated ? escalatedVideo.src : img.src
  const onVideoError = escalated ? escalatedVideo.onError : img.onError

  return {
    kind,
    imgSrc: img.src,
    imgRef: img.ref,
    onImgError: img.onError,
    videoSrc,
    onVideoError,
  }
}
