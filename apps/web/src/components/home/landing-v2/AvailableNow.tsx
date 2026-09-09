import Link from "next/link"
import { AuctionCard } from "@/components/auction/AuctionCard"
import { getAuctionShelf } from "@/lib/landing-auctions"

const MAX_ITEMS = 6

/** Live PND auctions across every artist-owned house. Surface releases
 * have their own venue section above this one. */
export async function AvailableNow() {
  const shelf = await getAuctionShelf().catch(() => null)
  const now = Math.floor(Date.now() / 1000)
  const items = (shelf ?? [])
    .filter((auction) => auction.endTime === 0 || auction.endTime > now)
    .slice(0, MAX_ITEMS)

  return (
    <section aria-labelledby="available-now" className="space-y-5">
      <div>
        <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-status-available">
          Live availability
        </p>
        <h2 id="available-now" className="mt-1 text-2xl font-semibold tracking-tight">
          Available now
        </h2>
      </div>

      {items.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <AuctionCard
              key={`auction:${item.house}:${item.auctionId}`}
              card={item}
              now={now}
            />
          ))}
        </ul>
      ) : shelf === null ? (
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            Live availability is temporarily unavailable. Browse artist
            profiles or try again shortly.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">No auctions are open right now.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-mono">
        <Link href="/auctions" className="underline underline-offset-4 hover:text-gray-600">
          All auctions
        </Link>
      </div>
    </section>
  )
}
