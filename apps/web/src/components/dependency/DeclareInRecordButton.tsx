"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import type { Address } from "viem"

/**
 * Inline CTA rendered next to a dependency-report contract row when:
 *   1. the connected wallet matches the URL artist (same owner gate
 *      the /record edit mode uses)
 *   2. the entry has NOT already been declared in the registry
 *
 * Clicking opens the /record page with the contract address
 * pre-filled in the Add form — one extra click + signature and the
 * row's "Declared in record" chip will appear on this page after the
 * artist returns and the 30s partial-cache TTL expires (or sooner via
 * router.refresh on the /record side).
 */
export function DeclareInRecordButton({
  artist,
  contract,
}: {
  artist: Address
  contract: string
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const { address, isConnected } = useAccount()

  if (!mounted || !isConnected || !address) return null
  if (address.toLowerCase() !== artist.toLowerCase()) return null

  const href = `/record/${artist.toLowerCase()}?addContract=${contract}`
  return (
    <a
      href={href}
      className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
    >
      Declare in your record →
    </a>
  )
}
