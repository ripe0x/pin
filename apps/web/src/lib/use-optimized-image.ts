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
 *     to the next gateway via `useIpfsGatewayFallback`. The reset
 *     effect re-enables the proxy for the new gateway URL.
 *  4. If both proxy and raw have failed for a non-rotatable URL
 *     (arweave, etc.), leave `src` on the raw URL — better to show a
 *     broken image once than oscillate forever between weserv and raw.
 *
 * Non-proxyable URLs (`data:`, on-chain SVG, video, unknown hosts) flow
 * through unchanged — `optimizeImageUrl` returns them as-is.
 *
 * Returns a `ref` to attach to the `<img>`. This is necessary because
 * an IMG rendered in the server-side HTML may have already fired its
 * native error event (e.g., weserv 404 for an oversized source) before
 * React hydrates — the React onError handler would attach too late and
 * miss it. On mount we inspect `complete + naturalWidth` and synthesize
 * the fallback if the IMG is in a broken state.
 */
export function useOptimizedImage(initialUrl: string, width = 800) {
  const { src: rawSrc, onError: onRawError } =
    useIpfsGatewayFallback(initialUrl)
  const [useProxy, setUseProxy] = useState(true)
  const lastRawRef = useRef<string>(rawSrc)
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    if (lastRawRef.current !== rawSrc) {
      lastRawRef.current = rawSrc
      setUseProxy(true)
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
    onRawError()
  }, [proxyApplied, onRawError])

  // Catch SSR-rendered images that already failed before hydration —
  // their native error event has come and gone, so the React handler
  // never fires. Re-check on every src change in case a fallback URL
  // also fails synchronously from a stale browser cache.
  useEffect(() => {
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth === 0) {
      onError()
    }
  }, [displaySrc, onError])

  return { src: displaySrc, onError, ref: imgRef }
}
