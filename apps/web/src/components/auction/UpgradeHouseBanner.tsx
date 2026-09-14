"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useArtistHouse } from "./useArtistHouse"
import { useArtistHouseV2 } from "./useArtistHouseV2"

/**
 * Auction-house tab pointer to the V1 to V2 upgrade flow on the migrate
 * page. Renders only when the V2 factory is live and the artist has a V1
 * house, and hides again once a V2 house exists and the V1 house has no
 * remaining listings.
 */
export function UpgradeHouseBanner({ artistAddress }: { artistAddress: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <Banner artistAddress={artistAddress} />
}

function Banner({ artistAddress }: { artistAddress: string }) {
  const v1 = useArtistHouse(artistAddress)
  const v2 = useArtistHouseV2(artistAddress)
  const [v1ListingCount, setV1ListingCount] = useState<number | null>(null)

  useEffect(() => {
    if (!v1.houseAddress) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/house-upgrade/${v1.houseAddress}`)
        if (!res.ok) return
        const data = (await res.json()) as { listings: unknown[] }
        if (!cancelled) setV1ListingCount(data.listings.length)
      } catch {
        // Leave null; the banner still shows while a V1 house exists.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [v1.houseAddress])

  if (!v2.factoryAddress || !v1.houseAddress) return null
  if (v2.houseAddress && v1ListingCount === 0) return null

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 flex items-center justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold">
          {v2.houseAddress ? "Finish your V2 upgrade" : "V2 auction house available"}
        </h3>
        <p className="text-xs text-gray-500 mt-0.5">
          {v2.houseAddress
            ? "Your V2 house is deployed. Move your remaining V1 listings over."
            : "Move your open listings to a V2 house. Same reserves and durations, one guided run."}
        </p>
      </div>
      <Link
        href={`/studio/${artistAddress}/migrate`}
        className="text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors whitespace-nowrap"
      >
        Upgrade →
      </Link>
    </div>
  )
}
