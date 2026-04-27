"use client"

import { useRef, useState } from "react"
import { IPFS_GATEWAYS } from "@pin/shared"

/**
 * Browser-side fallback for `<img>` / `<video>` tags pointing at an IPFS
 * gateway URL. If the current gateway 404s or hangs, swaps `src` to the next
 * gateway in `IPFS_GATEWAYS`. Once all gateways are exhausted, gives up
 * (the broken-image icon remains).
 *
 * The element gets the returned `src` + `onError` props.
 */
export function useIpfsGatewayFallback(initialUrl: string) {
  const [src, setSrc] = useState(initialUrl)
  // Track which gateway URLs we've already tried so we don't loop on a
  // gateway that 404s consistently.
  const tried = useRef<Set<string>>(new Set([initialUrl]))

  function onError() {
    // The current src must be a `${gateway}/ipfs/${cid}` URL for rotation
    // to make sense. Non-IPFS URLs (placeholders, http(s) without /ipfs/)
    // can't rotate — leave them as-is.
    const match = src.match(/\/ipfs\/(.+)$/)
    if (!match) return
    const cidPath = match[1]

    for (const gw of IPFS_GATEWAYS) {
      const candidate = `${gw}/ipfs/${cidPath}`
      if (!tried.current.has(candidate)) {
        tried.current.add(candidate)
        setSrc(candidate)
        return
      }
    }
    // All gateways exhausted; leave src alone.
  }

  return { src, onError }
}
