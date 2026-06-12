"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useIsStudioOwner } from "@/components/studio/useIsStudioOwner"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { fetchSellerCancellableListings } from "@/lib/seller-listings"
import { studioToolHref } from "@/lib/studio-tools"

/**
 * "Needs attention" items at the top of the studio dashboard.
 *
 * RPC BUDGET (hard invariant — do not grow this silently): one
 * pg-cached /api/seller-listings fetch + one houseOf read + one
 * pg/ENS-cached /api/artist/[address]/ens-url fetch, all owner-only.
 * These are exactly the reads the old artist-page panels paid on every
 * self-visit; they now fire once, here, on a deliberate studio visit.
 * A new item must be fed by a static link, an existing indexer-backed
 * API, or an already-firing read — never a fresh chain read.
 */
export function StudioActionQueue({ address }: { address: string }) {
  const isOwner = useIsStudioOwner(address)

  // Third-party listings count — same pg-cached API the old
  // MigrationBanner used (5-min cache server-side).
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
          await fetchSellerCancellableListings(address)
        if (!cancelled) setListingCount(auctions.length + buyNows.length)
      } catch {
        if (!cancelled) setListingCount(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOwner, address])

  // Sovereign house — single houseOf read, owner-gated; wagmi dedupes
  // it with any other useArtistHouse caller in the tree.
  const { factoryAddress, houseAddress, isLoading: houseLoading } =
    useArtistHouse(isOwner ? address : undefined)

  // Artist site — ENS `url` text record via the existing API route,
  // same read the old SitePanel fired on every artist-page visit.
  const [siteUrl, setSiteUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!isOwner) return
    let cancelled = false
    fetch(`/api/artist/${address}/ens-url`)
      .then((r) => r.json())
      .then(({ url }: { url: string | null }) => {
        if (!cancelled) setSiteUrl(url ?? null)
      })
      .catch(() => {
        if (!cancelled) setSiteUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [isOwner, address])

  if (!isOwner) return null

  const items: { key: string; text: string; href: string; cta: string; urgent?: boolean }[] = []

  if (listingCount && listingCount > 0) {
    items.push({
      key: "listings",
      text: `You have ${listingCount} active ${listingCount === 1 ? "listing" : "listings"} on third-party marketplaces.`,
      href: studioToolHref(address, "listings"),
      cta: "Review",
      urgent: true,
    })
  }

  if (factoryAddress && !houseLoading && !houseAddress) {
    items.push({
      key: "house",
      text: "You have not deployed your Sovereign auction house yet.",
      href: studioToolHref(address, "auctions"),
      cta: "Deploy",
    })
  }

  if (siteUrl === null) {
    items.push({
      key: "site",
      text: "No artist site is linked from your ENS profile.",
      href: studioToolHref(address, "site"),
      cta: "Set up",
    })
  }

  if (items.length === 0) return null

  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
        Needs attention
      </h2>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.key}
            className={`flex items-center justify-between gap-4 rounded-md border p-3 ${
              item.urgent
                ? "border-amber-200 bg-amber-50"
                : "border-gray-200 bg-surface"
            }`}
          >
            <p
              className={`text-sm ${item.urgent ? "text-amber-900" : "text-gray-700"}`}
            >
              {item.text}
            </p>
            <Link
              href={item.href}
              className="shrink-0 text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors"
            >
              {item.cta} →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
