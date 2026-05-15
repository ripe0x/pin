"use client"

import { useOptimizedImage } from "@/lib/use-optimized-image"

type Props = {
  src: string
  alt: string
  width?: number
  className?: string
  loading?: "lazy" | "eager"
}

/**
 * Thin client wrapper around a plain `<img>` that routes the `src`
 * through `useOptimizedImage` — weserv-resized WebP with gateway-
 * rotation + raw-URL fallback. Lets server components render an
 * optimized thumbnail without hand-rolling a client subcomponent.
 *
 * When every fallback has failed (e.g. weserv rejects an oversized
 * source and there's no IPFS gateway to rotate to), renders a plain
 * `bg-gray-100` placeholder instead of the browser's broken-image
 * icon so the layout stays clean.
 *
 * `width` is the weserv resize target (≈2× display width covers most
 * DPR). For 40px display thumbs pass 96; for grid tiles pass 600-800.
 */
export function OptimizedImage({
  src,
  alt,
  width = 400,
  className,
  loading = "lazy",
}: Props) {
  const {
    src: mediaSrc,
    onError,
    ref,
    failed,
  } = useOptimizedImage(src, width)
  if (failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`${className ?? ""} bg-gray-100`}
      />
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={mediaSrc}
      alt={alt}
      loading={loading}
      onError={onError}
      className={className}
    />
  )
}
