"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useIsStudioOwner } from "@/components/studio/useIsStudioOwner"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { fetchSellerCancellableListings } from "@/lib/seller-listings"
import { studioToolHref } from "@/lib/studio-tools"

/**
 * The one piece of owner chrome on the public artist page: a slim
 * ribbon under the header that says "this is your public page" and
 * points into the studio, with at most two attention chips.
 *
 * RPC BUDGET (hard invariant — do not grow this silently): static
 * links + one pg-cached /api/seller-listings count + the houseOf read
 * ArtistHeader's HouseLinkPill already fires for every visitor (wagmi
 * dedupes, so the chip is free). A new chip must be a static link or
 * indexer-backed — never a fresh chain read. This budget is what keeps
 * the ribbon from re-growing into the panel wall it replaced.
 */
export function StudioBar({ artistAddress }: { artistAddress: string }) {
  const isOwner = useIsStudioOwner(artistAddress)

  const [listingCount, setListingCount] = useState<number | null>(null)
  useEffect(() => {
    if (!isOwner) {
      setListingCount(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const { auctions, buyNows } =
          await fetchSellerCancellableListings(artistAddress)
        if (!cancelled) setListingCount(auctions.length + buyNows.length)
      } catch {
        if (!cancelled) setListingCount(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOwner, artistAddress])

  const { factoryAddress, houseAddress, isLoading: houseLoading } =
    useArtistHouse(isOwner ? artistAddress : undefined)

  if (!isOwner) return null

  const showListingsChip = !!listingCount && listingCount > 0
  const showHouseChip = !!factoryAddress && !houseLoading && !houseAddress

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border border-gray-200 rounded-md px-4 py-2.5">
      <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
        Your public page — this is what visitors see
      </p>
      <div className="flex items-center gap-2 overflow-x-auto">
        {showListingsChip && (
          <Link
            href={studioToolHref(artistAddress, "listings")}
            className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-mono border border-amber-200 bg-amber-50 text-amber-900 px-2.5 py-1 rounded-full hover:border-amber-400 transition-colors"
          >
            {listingCount} {listingCount === 1 ? "listing" : "listings"} on
            other platforms
          </Link>
        )}
        {showHouseChip && (
          <Link
            href={studioToolHref(artistAddress, "auctions")}
            className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-mono border border-gray-200 text-gray-600 px-2.5 py-1 rounded-full hover:border-gray-400 transition-colors"
          >
            No auction house yet
          </Link>
        )}
        <Link
          href={studioToolHref(artistAddress)}
          className="shrink-0 text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors"
        >
          Open studio →
        </Link>
      </div>
    </div>
  )
}
