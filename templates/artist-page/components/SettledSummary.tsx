/**
 * Settled-auction summary panel. Direct translation of the PND main app's
 * `SettledAuctionSummary` (`components/auction/SettledAuctionSummary.tsx`):
 * status dot + label, big winning bid, "won by …", relative settle time,
 * then a bid history table with the same compact mono rows.
 */
import type { AuctionSummary, BidEntry } from "@/lib/auctions"
import { explorerAddressUrl } from "@/lib/explorer"
import { displayFor, formatEth, formatRelativeTime } from "@/lib/format"
import { BidHistory } from "./BidHistory"

type Props = {
  auction: AuctionSummary
  bids: BidEntry[]
  ensMap?: Map<string, string>
  /** Block timestamp of AuctionEnded — null when unknown. */
  settledAtTime: number | null
}

export function SettledSummary({ auction, bids, ensMap, settledAtTime }: Props) {
  if (auction.status === "cancelled") {
    return (
      <div className="rounded-lg border border-gray-200 bg-surface p-5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
            Auction cancelled
          </span>
        </div>
      </div>
    )
  }

  const winnerDisplay = auction.winner
    ? displayFor(auction.winner, ensMap)
    : null
  const winnerIsAddress = winnerDisplay?.startsWith("0x") ?? false

  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="p-5 space-y-5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-sold" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
            Auction settled
          </span>
        </div>

        <div className="flex items-end justify-between gap-6">
          <div className="space-y-1">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              Winning bid
            </p>
            <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
              {auction.finalPrice ? formatEth(auction.finalPrice) : "—"}{" "}
              <span className="text-sm font-mono text-gray-500">ETH</span>
            </p>
            {winnerDisplay && (
              <p className="text-[11px] font-mono text-gray-500 pt-1">
                won by{" "}
                <a
                  href={explorerAddressUrl(auction.winner)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`hover:opacity-70 transition-opacity ${winnerIsAddress ? "font-mono" : ""}`}
                >
                  {winnerDisplay}
                </a>
              </p>
            )}
          </div>
          {settledAtTime ? (
            <div className="text-right space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Settled
              </p>
              <p className="text-sm font-mono tabular-nums leading-none text-gray-500">
                {formatRelativeTime(settledAtTime)}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {bids.length > 0 && (
        <div className="px-5 py-4 border-t border-gray-100">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-3">
            Bid history
          </p>
          <BidHistory bids={bids} ensMap={ensMap} />
        </div>
      )}
    </div>
  )
}
