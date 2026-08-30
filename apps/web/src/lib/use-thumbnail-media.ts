"use client"

import { useEffect, useState } from "react"
import { ipfsToHttp } from "@pin/shared"
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
export function useThumbnailMedia(
  url: string,
  width = 800,
  mediaKind?: string | null,
) {
  const resolvedUrl = ipfsToHttp(url)
  const img = useOptimizedImage(resolvedUrl, width)
  // Fresh gateway cascade for the escalated <video> — the `img` cascade is
  // exhausted by the time we escalate.
  const escalatedVideo = useIpfsGatewayFallback(resolvedUrl)
  const [escalated, setEscalated] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)

  const knownVideo = mediaKind === "video" || isVideoUrl(resolvedUrl)
  const ambiguous =
    mediaKind == null || mediaKind === "unknown"
      ? isAmbiguousMediaUrl(resolvedUrl)
      : false

  useEffect(() => {
    setEscalated(false)
    setVideoFailed(false)
  }, [resolvedUrl, mediaKind])

  // Escalate once the image cascade is exhausted on an ambiguous URL.
  // Setting state during render (React-supported) re-renders immediately,
  // avoiding a flash of the broken/placeholder state.
  if (img.failed && ambiguous && !escalated) {
    setEscalated(true)
  }

  const kind: ThumbnailMediaKind =
    videoFailed
      ? "failed"
      : knownVideo || escalated
        ? "video"
        : img.failed
          ? "failed"
          : "image"

  // Known-extension video: reuse the optimized-image cascade (it passes
  // video URLs through unproxied). Escalated case: that cascade is spent,
  // so drive the video off the fresh gateway cascade.
  const videoSrc = knownVideo || escalated ? escalatedVideo.src : img.src
  const onVideoError = () => {
    const rotated =
      knownVideo || escalated
        ? escalatedVideo.onError()
        : (img.onError(), true)
    if (!rotated) setVideoFailed(true)
  }

  return {
    kind,
    imgSrc: img.src,
    imgRef: img.ref,
    onImgError: img.onError,
    videoSrc,
    onVideoError,
  }
}
