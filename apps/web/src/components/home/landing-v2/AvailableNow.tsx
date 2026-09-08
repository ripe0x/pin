import Link from "next/link"
import { formatEther } from "viem"
import { Artwork } from "@/components/media/Artwork"
import { getAuctionShelf, type AuctionShelfCard } from "@/lib/landing-auctions"

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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-status-available">
            Live availability
          </p>
          <h2 id="available-now" className="mt-1 text-2xl font-semibold tracking-tight">
            Available now
          </h2>
        </div>
        <p className="text-xs font-mono text-gray-500">
          Current contract state, checked before you transact
        </p>
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

function AuctionCard({ card, now }: { card: AuctionShelfCard; now: number }) {
  const status =
    card.endTime === 0
      ? "Waiting for first bid"
      : `Ends ${formatEndsIn(card.endTime - now)}`
  const quantity = BigInt(card.quantity)
  const quantityLabel = quantity > 1n ? ` · ${quantity} editions` : ""

  return (
    <li>
      <Link
        href={`/auction/${card.house}/${card.auctionId}`}
        className="group block h-full overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400"
      >
        <div className="aspect-[4/3] overflow-hidden bg-gray-100">
          <Artwork media={card.artwork} alt={card.title ?? `Token #${card.tokenId}`} />
        </div>
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-medium uppercase tracking-wider text-status-available">
              <span className="h-1.5 w-1.5 rounded-full bg-status-available" aria-hidden="true" />
              Open auction
            </span>
            <span className="text-[10px] font-mono text-gray-500">Artist-owned house</span>
          </div>
          <div>
            <h3 className="truncate text-base font-medium tracking-tight">
              {card.title ?? `Token #${card.tokenId}`}
            </h3>
            <p className="mt-1 truncate text-xs font-mono text-gray-500">
              by {card.sellerLabel}
            </p>
          </div>
          <div className="flex items-end justify-between gap-3 border-t border-gray-200 pt-3">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                {card.hasBid ? "Current bid" : "Reserve"}
              </p>
              <p className="mt-0.5 text-sm font-mono tabular-nums">
                {formatEth(BigInt(card.priceWei))}
              </p>
            </div>
            <p className="text-right text-[11px] font-mono text-gray-600">
              {status}
              {quantityLabel}
            </p>
          </div>
        </div>
      </Link>
    </li>
  )
}

function formatEth(wei: bigint): string {
  const value = Number(formatEther(wei))
  const digits = value >= 1 ? 3 : 4
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })} ETH`
}

function formatEndsIn(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.ceil(seconds / 60))}m`
  if (seconds < 86_400) return `${Math.ceil(seconds / 3600)}h`
  return `${Math.ceil(seconds / 86_400)}d`
}
