import { formatEther } from "viem"
import type { SettledAuction } from "@/lib/indexer-queries"

function formatRelativeTime(unixSec: number): string {
  if (unixSec === 0) return ""
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSec)
  if (diffSec < 60) return `${diffSec}s ago`
  const m = Math.floor(diffSec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

function isAddress(display: string): boolean {
  return display.startsWith("0x")
}

export function SettledAuctionSummary({
  auction,
}: {
  auction: SettledAuction
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="p-5 space-y-5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400" />
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
              {formatEther(auction.amount)}{" "}
              <span className="text-sm font-mono text-gray-500">ETH</span>
            </p>
            {auction.winnerDisplay && (
              <p className="text-[11px] font-mono text-gray-500 pt-1">
                won by{" "}
                <span className={isAddress(auction.winnerDisplay) ? "font-mono" : ""}>
                  {auction.winnerDisplay}
                </span>
              </p>
            )}
          </div>
          <div className="text-right space-y-1">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              Settled
            </p>
            <p className="text-sm font-mono tabular-nums leading-none text-gray-500">
              {formatRelativeTime(auction.settledAtTime)}
            </p>
          </div>
        </div>
      </div>

      {auction.bids.length > 0 && (
        <div className="px-5 py-4 border-t border-gray-100">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-3">
            Bid history
          </p>
          <ol className="space-y-2">
            {auction.bids.map((bid) => (
              <li
                key={`${bid.txHash}-${bid.bidder}`}
                className="flex items-baseline justify-between text-[11px] font-mono"
              >
                <a
                  href={`https://etherscan.io/tx/${bid.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-baseline gap-2 min-w-0 hover:opacity-70 transition-opacity"
                >
                  <span className="truncate text-gray-700">
                    {bid.bidderDisplay}
                  </span>
                  <span className="text-gray-400 shrink-0">
                    {formatRelativeTime(bid.blockTime)}
                  </span>
                </a>
                <span className="tabular-nums text-gray-900 shrink-0 ml-3">
                  {formatEther(bid.amount)} ETH
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
