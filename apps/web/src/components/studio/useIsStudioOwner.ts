"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"

/**
 * The app-wide owner gate: true once mounted + the connected wallet's
 * address matches the given artist address. Gated on a mount check so
 * server-rendered HTML never includes owner-only UI (which would cause
 * a hydration mismatch — wagmi knows nothing about the wallet during
 * SSR).
 *
 * This is presentational gating only — there is no session or SIWE.
 * Real authorization is enforced onchain (writes revert for the wrong
 * msg.sender) and by the API routes' own rate limits.
 *
 * Future hook point: when registry-operator delegation ships (the
 * ArtistRecordRegistry already supports setOperator onchain), this is
 * where an on-demand isOperator lookup would widen the gate — as a
 * lazy, owner-triggered read, never a default check for every visitor.
 */
export function useIsStudioOwner(artist: string): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const { address, isConnected } = useAccount()
  if (!mounted || !isConnected || !address) return false
  return address.toLowerCase() === artist.toLowerCase()
}
