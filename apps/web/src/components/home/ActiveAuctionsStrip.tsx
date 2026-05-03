import type { ActiveAuctionSummary } from "@/lib/platforms"
import { AuctionCard } from "./AuctionCard"
import { LazyAuctionCard } from "./LazyAuctionCard"

// Cards rendered eagerly on the server. Sized to comfortably cover
// the visible portion of the strip on a wide viewport (4–5 fully
// visible + 2–3 in the scroll head-start). Everything past this
// renders as a `LazyAuctionCard` that fetches metadata on demand
// when it scrolls within ~400px of the viewport.
const EAGER_COUNT = 8

/**
 * Horizontal-scroll carousel of active auctions. Renders nothing when
 * empty — caller is responsible for filtering + ordering. Negative
 * margin + matching padding lets the strip bleed to the viewport edge
 * while staying inside the page's max-width container.
 *
 * The first `EAGER_COUNT` cards are server-rendered with full
 * metadata so the strip is meaningful on first paint. Remaining
 * cards render placeholders client-side and lazy-fetch their token
 * metadata via `/api/meta` when the user scrolls them into view.
 * This keeps the SSR cost flat regardless of how many active auctions
 * the platform adapters return.
 */
export function ActiveAuctionsStrip({
  auctions,
}: {
  auctions: ActiveAuctionSummary[]
}) {
  if (auctions.length === 0) return null

  const eager = auctions.slice(0, EAGER_COUNT)
  const lazy = auctions.slice(EAGER_COUNT)

  return (
    <section className="py-6 space-y-4">
      <header className="flex items-baseline justify-between gap-4">
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          Live auctions
        </h2>
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          {auctions.length} now
        </span>
      </header>
      <ul className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-2 -mx-6 px-6">
        {eager.map((a) => (
          <li
            key={`${a.platform}:${a.contract}:${a.tokenId}`}
            className="snap-start"
          >
            <AuctionCard
              contract={a.contract}
              tokenId={a.tokenId}
              currentBidWei={a.currentBidWei}
              reservePrice={a.reserveWei}
              endTime={a.endTime}
              platform={a.platform}
            />
          </li>
        ))}
        {lazy.map((a) => (
          <li
            key={`${a.platform}:${a.contract}:${a.tokenId}`}
            className="snap-start"
          >
            <LazyAuctionCard
              contract={a.contract}
              tokenId={a.tokenId}
              currentBidWei={a.currentBidWei}
              reservePrice={a.reserveWei}
              endTime={a.endTime}
              platform={a.platform}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
