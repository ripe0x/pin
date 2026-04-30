export type ProvenanceEntry = {
  event: "Minted" | "Transferred" | "Listed" | "Sold" | "Bid Placed"
  from: string
  fromHandle: string
  to?: string
  toHandle?: string
  timestamp: number
  txHash: string
  /** ERC1155 transfer amount (number of copies). Omitted/1 for ERC721. */
  amount?: bigint
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function Provenance({ entries }: { entries: ProvenanceEntry[] }) {
  if (entries.length === 0) return null

  return (
    <div>
      <h3 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Provenance
      </h3>
      <ul className="space-y-0">
        {entries.map((entry, i) => (
          <li key={entry.txHash + i} className="flex gap-3 py-2">
            {/* Timeline dot + line */}
            <div className="flex flex-col items-center pt-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-fg" />
              {i < entries.length - 1 && (
                <div className="w-px flex-1 bg-gray-200 mt-1" />
              )}
            </div>

            <div className="flex-1 pb-1 space-y-0.5">
              <p className="text-[11px] font-mono">
                <span>{entry.event}</span>
                {entry.amount !== undefined && entry.amount > 1n && (
                  <span className="text-gray-400"> ×{entry.amount.toString()}</span>
                )}
                <span className="text-gray-400"> by </span>
                <span>{entry.fromHandle}</span>
                {entry.toHandle && (
                  <>
                    <span className="text-gray-400"> → </span>
                    <span>{entry.toHandle}</span>
                  </>
                )}
              </p>
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-mono text-gray-400">
                  {formatDate(entry.timestamp)}
                </p>
                <a
                  href={`https://evm.now/tx/${entry.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-gray-400 hover:text-fg transition-colors"
                >
                  ↗
                </a>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
