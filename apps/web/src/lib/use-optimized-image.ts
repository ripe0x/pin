"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useIpfsGatewayFallback } from "./use-ipfs-fallback"
import { optimizeImageUrl } from "./optimize-image-url"

/**
 * Below this requested width, treat the proxy as the only attempt: if
 * weserv refuses (e.g. >71-megapixel arweave source), do NOT fall back
 * to the raw URL — that would download the full original (often tens of
 * MB) just to render at a thumbnail size. Show a placeholder instead.
 *
 * Above this width the raw fallback is allowed because the image IS the
 * primary content (gallery tile) and the user is expecting a real
 * picture even if it's heavy.
 */
const THUMBNAIL_WIDTH_THRESHOLD = 200
const RAW_RETRY_DELAYS_MS = [500, 1_500] as const

function withRetryParam(src: string, retryAttempt: number): string {
  if (retryAttempt === 0 || !/^https?:\/\//i.test(src)) return src
  try {
    const url = new URL(src)
    url.searchParams.set("pnd_retry", String(retryAttempt))
    return url.toString()
  } catch {
    return src
  }
}

/**
 * Image source hook for grid tiles. Layers fallbacks differently
 * depending on whether the caller wants a thumbnail or a full tile.
 *
 * **Tile mode** (width ≥ 200):
 *  1. weserv-optimized WebP — small, ~95% lighter than raw.
 *  2. If weserv errors, try the raw gateway URL.
 *  3. If raw errors and it's an IPFS URL, rotate gateway.
 *  4. Otherwise `failed` flips true → caller renders a placeholder.
 *
 * **Thumbnail mode** (width < 200):
 *  1. weserv-optimized WebP.
 *  2. If weserv errors and it's an IPFS URL, skip raw, rotate gateway,
 *     try weserv on the new gateway.
 *  3. Otherwise `failed` flips true. Critically, we do NOT fall back
 *     to the raw URL for thumbnails — the raw original is often tens
 *     of MB and would be wasted on a 40-pixel display.
 *
 * Non-proxyable URLs (`data:`, on-chain SVG, video, unknown hosts) flow
 * through unchanged — `optimizeImageUrl` returns them as-is.
 *
 * Returns a `ref` to attach to the `<img>`. This is necessary because
 * an IMG rendered in server-side HTML may have already fired its native
 * error event before React hydrates — the React onError handler would
 * attach too late and miss it. On mount we inspect `complete +
 * naturalWidth` and synthesize the fallback if the IMG is broken.
 */
export function useOptimizedImage(
  initialUrl: string,
  width = 800,
  options: { allowRawFallback?: boolean } = {},
) {
  const { src: rawSrc, onError: onRawError } =
    useIpfsGatewayFallback(initialUrl)
  const [useProxy, setUseProxy] = useState(true)
  const [failed, setFailed] = useState(false)
  const [rawRetryAttempt, setRawRetryAttempt] = useState(0)
  const lastRawRef = useRef<string>(rawSrc)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hydrationCheckedRef = useRef(false)

  useEffect(() => {
    setUseProxy(true)
    setFailed(false)
    setRawRetryAttempt(0)
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
  }, [initialUrl])

  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    },
    [],
  )

  // When the underlying gateway rotates (rawSrc changes), give the new
  // URL a fresh shot at the proxy and clear the failed state.
  useEffect(() => {
    if (lastRawRef.current !== rawSrc) {
      lastRawRef.current = rawSrc
      setUseProxy(true)
      setFailed(false)
      setRawRetryAttempt(0)
    }
  }, [rawSrc])

  const optimized = optimizeImageUrl(rawSrc, width)
  const proxyApplied = useProxy && optimized !== rawSrc
  const displaySrc = proxyApplied
    ? optimized
    : withRetryParam(rawSrc, rawRetryAttempt)

  const isThumbnail = width < THUMBNAIL_WIDTH_THRESHOLD
  const allowRawFallback = options.allowRawFallback ?? true

  const onError = useCallback(() => {
    if (proxyApplied) {
      if (isThumbnail || !allowRawFallback) {
        // Skip raw — see THUMBNAIL_WIDTH_THRESHOLD docstring. Try the
        // next IPFS gateway via proxy; if no rotation available, give
        // up and let the caller render a placeholder.
        const rotated = onRawError()
        if (!rotated) setFailed(true)
        return
      }
      setUseProxy(false)
      return
    }
    // Tile mode, raw URL also failed. Ask the gateway-rotation hook
    // to try the next gateway. If it can't rotate, the cascade is
    // exhausted — flip `failed` so the caller renders a placeholder.
    const rotated = onRawError()
    if (rotated) return

    // Centralized renderers can cold-start or fail transiently. A bounded
    // cache-busted retry avoids permanently replacing valid work with a
    // placeholder after one network error.
    if (
      /^https?:\/\//i.test(rawSrc) &&
      rawRetryAttempt < RAW_RETRY_DELAYS_MS.length &&
      !retryTimerRef.current
    ) {
      const delay = RAW_RETRY_DELAYS_MS[rawRetryAttempt]
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        setRawRetryAttempt((attempt) => attempt + 1)
      }, delay)
      return
    }
    setFailed(true)
  }, [
    proxyApplied,
    onRawError,
    isThumbnail,
    allowRawFallback,
    rawSrc,
    rawRetryAttempt,
  ])

  // Catch SSR-rendered images that already failed before hydration —
  // their native error event has come and gone, so the React handler
  // never fires.
  useEffect(() => {
    if (hydrationCheckedRef.current) return
    hydrationCheckedRef.current = true
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth === 0) {
      onError()
    }
  }, [onError])

  return { src: displaySrc, onError, ref: imgRef, failed }
}
