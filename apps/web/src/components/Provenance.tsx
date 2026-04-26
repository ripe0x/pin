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
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
        Provenance
      </h3>
      <ul className="space-y-0">
        {entries.map((entry, i) => (
          <li key={entry.txHash + i} className="flex gap-4 py-3">
            {/* Timeline dot + line */}
            <div className="flex flex-col items-center">
              <div className="h-2.5 w-2.5 rounded-full bg-black" />
              {i < entries.length - 1 && (
                <div className="w-px flex-1 bg-gray-200" />
              )}
            </div>

            <div className="flex-1 pb-2">
              <p className="text-sm">
                <span className="font-medium">{entry.event}</span>
                {entry.amount !== undefined && entry.amount > 1n && (
                  <span className="text-gray-400"> ×{entry.amount.toString()}</span>
                )}
                <span className="text-gray-400"> by </span>
                <span className="font-medium">{entry.fromHandle}</span>
                {entry.toHandle && (
                  <>
                    <span className="text-gray-400"> → </span>
                    <span className="font-medium">{entry.toHandle}</span>
                  </>
                )}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-xs text-gray-400">
                  {formatDate(entry.timestamp)}
                </p>
                <a
                  href={`https://evm.now/tx/${entry.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gray-400 hover:text-black transition-colors"
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
