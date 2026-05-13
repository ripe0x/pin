"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useAccount } from "wagmi"
import { fetchSellerCancellableListings } from "@/lib/seller-listings"

/**
 * Renders nothing unless the connected wallet is the artist AND has at least
 * one cancellable listing on a third-party marketplace (Foundation,
 * SuperRare, etc.). Mounted on /artist/[address] above the existing
 * panels; routes the artist to /artist/[address]/migrate where the full
 * migration flow lives.
 */
export function MigrationBanner({ artistAddress }: { artistAddress: string }) {
  const { address: connected } = useAccount()
  const isArtist =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!isArtist) {
      setCount(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const { auctions, buyNows } =
          await fetchSellerCancellableListings(artistAddress)
        if (cancelled) return
        setCount(auctions.length + buyNows.length)
      } catch {
        if (!cancelled) setCount(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isArtist, artistAddress])

  if (!isArtist) return null
  if (!count) return null

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-amber-900">
          You have {count} active {count === 1 ? "listing" : "listings"} on
          third-party marketplaces.
        </p>
        <p className="text-xs text-amber-800/80 mt-0.5">
          Migrate them to your Sovereign auction house in one guided flow —
          we&rsquo;ll prefill the reserve and duration from each existing
          listing.
        </p>
      </div>
      <Link
        href={`/artist/${artistAddress}/migrate`}
        className="inline-flex items-center text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors shrink-0"
      >
        Migrate →
      </Link>
    </div>
  )
}
