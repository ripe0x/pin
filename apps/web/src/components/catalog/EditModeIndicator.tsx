"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import type { Address } from "viem"

/**
 * Renders a small "your record" chip when the connected wallet matches
 * the URL artist, signaling that edit controls are available (chip 5).
 * Renders nothing otherwise to keep the read-only view clean.
 *
 * Gated on a mount check so server-rendered HTML doesn't include the
 * chip — useAccount() isn't reachable during SSR without WagmiProvider.
 */
export function EditModeIndicator({ artist }: { artist: Address }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const { address, isConnected } = useAccount()

  if (!mounted || !isConnected || !address) return null
  if (address.toLowerCase() !== artist.toLowerCase()) return null

  return (
    <span className="inline-flex items-center text-[11px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border border-emerald-300 text-emerald-700 bg-emerald-50">
      Your catalog
    </span>
  )
}
