"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import type { Address } from "viem"

/**
 * Returns true once mounted + the connected wallet's address matches
 * the URL artist's address. Gated on a mount check so the
 * server-rendered HTML doesn't include edit-only UI (which would
 * cause a hydration mismatch).
 */
export function useIsRecordOwner(artist: Address): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const { address, isConnected } = useAccount()
  if (!mounted || !isConnected || !address) return false
  return address.toLowerCase() === artist.toLowerCase()
}
