import Link from "next/link"
import type { Address } from "viem"
import { AuctionCard } from "@/components/auction/AuctionCard"
import { CatalogSection } from "@/components/artist/CatalogSection"
import { CollectedGrid, CoverageNote } from "@/components/artist/CollectedGrid"
import { PanelUnavailable } from "@/components/artist/PanelErrorBoundary"
import type { AuctionShelfCard } from "@/lib/landing-auctions"
import type { CollectorTokensPage } from "@/lib/reads"
import { getHoldingCards } from "@/lib/profile-reads"

/**
 * Tab panels of the unified profile (#299) other than Created, which is
 * the existing ArtistGallery. Each takes the read the page already made
 * for the tab counts (null = that read failed) so a panel never re-reads
 * what the tab bar just counted.
 */

/** Open PND auctions this address is selling. */
export function AvailablePanel({
  auctions,
}: {
  auctions: AuctionShelfCard[] | null
}) {
  const now = Math.floor(Date.now() / 1000)
  return (
    <section aria-label="Available" className="space-y-5">
      <p className="text-xs text-gray-500">
        Open auctions this address is running on artist-owned PND auction
        houses.
      </p>
      {auctions === null ? (
        <PanelUnavailable label="live availability" />
      ) : auctions.length === 0 ? (
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            Nothing from this address is open for bids right now.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {auctions.map((card) => (
            <AuctionCard key={`auction:${card.house}:${card.auctionId}`} card={card} now={now} />
          ))}
        </ul>
      )}
      <div className="text-xs font-mono">
        <Link href="/auctions" className="underline underline-offset-4 hover:text-gray-600">
          All auctions
        </Link>
      </div>
    </section>
  )
}

/** Current holdings among the works PND indexes. */
export async function CollectedPanel({
  address,
  page,
}: {
  address: string
  page: CollectorTokensPage | null
}) {
  if (page === null) return <PanelUnavailable label="holdings" />
  if (page.items.length === 0) {
    return (
      <div className="space-y-4">
        <CoverageNote />
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            No holdings among the works PND indexes yet.
          </p>
        </div>
      </div>
    )
  }
  const items = await getHoldingCards(page.items)
  return (
    <CollectedGrid
      address={address}
      initialPage={{
        items,
        total: page.total,
        nextCursor: page.nextCursor,
        coverage: page.coverage,
      }}
    />
  )
}

/** The address's onchain Catalog declarations (same view as /catalog/[address]). */
export function CatalogPanel({
  address,
  count,
}: {
  address: string
  count: number | null
}) {
  if (count === null) return <PanelUnavailable label="the Catalog record" />
  if (count === 0) {
    return (
      <div className="rounded-md border border-gray-200 p-5">
        <p className="text-sm text-fg-muted">
          This address has not declared anything on the public Catalog.
        </p>
        <Link
          href={`/catalog/${address.toLowerCase()}`}
          className="mt-3 inline-block text-xs font-mono underline underline-offset-4 hover:text-gray-600"
        >
          Catalog record
        </Link>
      </div>
    )
  }
  return <CatalogSection address={address as Address} />
}
