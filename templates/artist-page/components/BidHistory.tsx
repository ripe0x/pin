/**
 * Bid history list. Mirrors the PND main app's bid-history table from
 * `SettledAuctionSummary`: tiny mono rows, bidder display + relative
 * time on the left, amount on the right.
 */
import type { BidEntry } from "@/lib/auctions"
import { explorerTxUrl } from "@/lib/explorer"
import { displayFor, formatEth, formatRelativeTime } from "@/lib/format"

export function BidHistory({
  bids,
  ensMap,
}: {
  bids: BidEntry[]
  ensMap?: Map<string, string>
}) {
  if (bids.length === 0) {
    return (
      <p className="text-[11px] font-mono text-gray-500">No bids yet.</p>
    )
  }
  return (
    <ol className="space-y-2">
      {bids.map((b) => {
        const name = displayFor(b.bidder, ensMap)
        const isAddress = name.startsWith("0x")
        return (
          <li
            key={`${b.txHash}-${b.bidder}`}
            className="flex items-baseline justify-between text-[11px] font-mono"
          >
            <a
              href={explorerTxUrl(b.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-baseline gap-2 min-w-0 hover:opacity-70 transition-opacity"
            >
              <span
                className={`truncate text-gray-700 ${isAddress ? "font-mono" : ""}`}
              >
                {name}
              </span>
              <span className="text-gray-400 shrink-0">
                {formatRelativeTime(b.blockTime)}
              </span>
            </a>
            <span className="tabular-nums text-fg shrink-0 ml-3">
              {formatEth(b.amount)} ETH
            </span>
          </li>
        )
      })}
    </ol>
  )
}
