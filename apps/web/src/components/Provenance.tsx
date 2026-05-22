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

// Address/ENS handle rendered as a link to its evm.now address page. The
// link target is always the raw address; the handle (ENS or truncated 0x…)
// is just the display text.
function AddrLink({ addr, handle }: { addr?: string; handle?: string }) {
  if (!handle) return null
  if (!addr) return <span>{handle}</span>
  return (
    <a
      href={`https://evm.now/address/${addr}`}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline"
    >
      {handle}
    </a>
  )
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
                {entry.event === "Minted" ? (
                  // A mint's `from` is the zero address; the meaningful party
                  // is the recipient. Show "Minted by <recipient>", not
                  // "by 0x000… → <recipient>".
                  <AddrLink addr={entry.to} handle={entry.toHandle ?? entry.fromHandle} />
                ) : (
                  <>
                    <AddrLink addr={entry.from} handle={entry.fromHandle} />
                    {entry.toHandle && (
                      <>
                        <span className="text-gray-400"> → </span>
                        <AddrLink addr={entry.to} handle={entry.toHandle} />
                      </>
                    )}
                  </>
                )}
              </p>
              <a
                href={`https://evm.now/tx/${entry.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-mono text-gray-400 hover:text-fg hover:underline transition-colors"
              >
                {formatDate(entry.timestamp)}
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
