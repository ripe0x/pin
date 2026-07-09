"use client"

import { useRef, useState } from "react"
import { IPFS_GATEWAYS, ARWEAVE_GATEWAYS, extractArweavePath } from "@pin/shared"

/**
 * Browser-side fallback for `<img>` / `<video>` tags pointing at an IPFS or
 * Arweave gateway URL. If the current gateway 404s or hangs, swaps `src` to
 * the next gateway in the matching list. Once all gateways are exhausted,
 * gives up (the broken-image icon remains).
 *
 * Arweave is included because a freshly-uploaded (or optimistically-served)
 * bundle can 404 on arweave.net while other ar.io gateways already serve the
 * byte-identical file — same failure mode as a single dead IPFS gateway.
 *
 * The element gets the returned `src` + `onError` props. `onError`
 * returns `true` if it rotated to a new gateway, `false` if it couldn't
 * (unrecognized URL or gateways exhausted) — callers that want to render a
 * placeholder once the cascade is exhausted can branch on this.
 */
export function useIpfsGatewayFallback(initialUrl: string) {
  const [src, setSrc] = useState(initialUrl)
  // Track which gateway URLs we've already tried so we don't loop on a
  // gateway that 404s consistently.
  const tried = useRef<Set<string>>(new Set([initialUrl]))

  function rotate(candidates: string[]): boolean {
    for (const candidate of candidates) {
      if (!tried.current.has(candidate)) {
        tried.current.add(candidate)
        setSrc(candidate)
        return true
      }
    }
    return false
  }

  function onError(): boolean {
    // IPFS: rotate on the `/ipfs/<cid>[/path]` tail.
    const ipfsMatch = src.match(/\/ipfs\/(.+)$/)
    if (ipfsMatch) {
      const cidPath = ipfsMatch[1]
      return rotate(IPFS_GATEWAYS.map((gw) => `${gw}/ipfs/${cidPath}`))
    }

    // Arweave: rotate across ar.io gateways, preserving the tx id and any
    // path-manifest sub-path. Recognizes both arweave.net and a URL already
    // rotated onto a fallback gateway.
    const arPath = extractArweavePath(src)
    if (arPath) {
      return rotate(ARWEAVE_GATEWAYS.map((gw) => `${gw}/${arPath}`))
    }

    // Non-IPFS/Arweave URLs (placeholders, plain http(s)) can't rotate.
    return false
  }

  return { src, onError }
}
