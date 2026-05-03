import type { BidEntry } from "@/lib/auctions"
import { displayFor } from "@/lib/ens"
import { formatEth, formatRelativeTime } from "@/lib/format"

export function BidHistory({
  bids,
  ensMap,
}: {
  bids: BidEntry[]
  ensMap?: Map<string, string>
}) {
  if (bids.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))]">
        No bids yet.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-[hsl(var(--border))]">
      {bids.map((b) => {
        const name = displayFor(b.bidder, ensMap)
        const isEns = ensMap?.has(b.bidder.toLowerCase()) ?? false
        return (
          <li
            key={`${b.txHash}-${b.bidder}`}
            className="flex items-center justify-between py-2.5 text-sm"
          >
            <div className="flex flex-col">
              <a
                href={`https://etherscan.io/tx/${b.txHash}`}
                target="_blank"
                rel="noreferrer"
                className={isEns ? "hover:underline" : "font-mono hover:underline"}
              >
                {name}
              </a>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {formatRelativeTime(b.blockTime)}
              </span>
            </div>
            <span className="font-mono">{formatEth(b.amount)} ETH</span>
          </li>
        )
      })}
    </ul>
  )
}
