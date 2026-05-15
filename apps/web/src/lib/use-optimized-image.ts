"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useIpfsGatewayFallback } from "./use-ipfs-fallback"
import { optimizeImageUrl } from "./optimize-image-url"

/**
 * Image source hook for grid tiles. Layers two fallbacks:
 *
 *  1. Default `src` is the weserv-optimized version of the current IPFS
 *     gateway URL — small WebP, ~95% lighter than the raw original.
 *  2. If weserv errors (e.g. pixel-limit, fair-use throttle, outage),
 *     drop the proxy and try the raw gateway URL.
 *  3. If the raw URL also errors AND it's an IPFS gateway URL, rotate
 *     to the next gateway via `useIpfsGatewayFallback`.
 *  4. If everything has failed and there is nothing left to rotate to
 *     (non-IPFS URL or all gateways exhausted), `failed` flips to
 *     `true` so callers can render a placeholder instead of the
 *     browser's broken-image icon.
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
export function useOptimizedImage(initialUrl: string, width = 800) {
  const { src: rawSrc, onError: onRawError } =
    useIpfsGatewayFallback(initialUrl)
  const [useProxy, setUseProxy] = useState(true)
  const [failed, setFailed] = useState(false)
  const lastRawRef = useRef<string>(rawSrc)
  const imgRef = useRef<HTMLImageElement | null>(null)

  // When the underlying gateway rotates (rawSrc changes), give the new
  // URL a fresh shot at the proxy and clear the failed state.
  useEffect(() => {
    if (lastRawRef.current !== rawSrc) {
      lastRawRef.current = rawSrc
      setUseProxy(true)
      setFailed(false)
    }
  }, [rawSrc])

  const optimized = optimizeImageUrl(rawSrc, width)
  const proxyApplied = useProxy && optimized !== rawSrc
  const displaySrc = useProxy ? optimized : rawSrc

  const onError = useCallback(() => {
    if (proxyApplied) {
      setUseProxy(false)
      return
    }
    // Raw URL also failed. Ask the gateway-rotation hook to try the
    // next gateway. If it can't rotate, the cascade is exhausted —
    // flip `failed` so the caller renders a placeholder.
    const rotated = onRawError()
    if (!rotated) setFailed(true)
  }, [proxyApplied, onRawError])

  // Catch SSR-rendered images that already failed before hydration —
  // their native error event has come and gone, so the React handler
  // never fires.
  useEffect(() => {
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth === 0) {
      onError()
    }
  }, [displaySrc, onError])

  return { src: displaySrc, onError, ref: imgRef, failed }
}
