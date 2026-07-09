"use client"

import { useRef, useState } from "react"
import {
  IPFS_GATEWAYS,
  ARWEAVE_GATEWAYS,
  extractIpfsPath,
  extractArweavePath,
} from "./media-fallback"

/**
 * Browser-side gateway fallback for `<img>` / `<video>` src. On load error,
 * rotates to the next IPFS or Arweave gateway serving the same
 * content-addressed file. Mirrors PND's `useIpfsGatewayFallback`, generalized
 * to Arweave (a fresh arweave.net bundle can 404 while other ar.io gateways
 * already serve it).
 *
 * `onError` returns `true` if it rotated to a new gateway, `false` if it
 * couldn't (unrecognized URL or gateways exhausted) — so callers can defer
 * other fallbacks (e.g. image→video escalation) until the gateways are spent.
 */
export function useMediaFallback(initialUrl: string | null) {
  const [src, setSrc] = useState<string | null>(initialUrl)
  const tried = useRef<Set<string>>(new Set(initialUrl ? [initialUrl] : []))

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
    if (!src) return false
    const ipfs = extractIpfsPath(src)
    if (ipfs) return rotate(IPFS_GATEWAYS.map((g) => g + ipfs))
    const ar = extractArweavePath(src)
    if (ar) return rotate(ARWEAVE_GATEWAYS.map((g) => `${g}/${ar}`))
    return false
  }

  return { src, onError }
}
