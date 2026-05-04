/**
 * Vertical timeline of provenance events for a token. Mirrors the PND
 * main app's `components/Provenance.tsx`: `text-[10px] font-mono` heading,
 * a small filled dot per row, vertical line between rows, and tx-hash
 * deep links to the block explorer.
 */
import { explorerTxUrl } from "@/lib/explorer"
import { displayFor } from "@/lib/format"
import type { ProvenanceEntry } from "@/lib/token"

function formatDate(timestamp: number): string {
  if (timestamp === 0) return ""
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function Provenance({
  entries,
  ensMap,
}: {
  entries: ProvenanceEntry[]
  ensMap?: Map<string, string>
}) {
  if (entries.length === 0) return null

  return (
    <div>
      <h3 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Provenance
      </h3>
      <ul className="space-y-0">
        {entries.map((entry, i) => (
          <li key={entry.txHash + i} className="flex gap-3 py-2">
            <div className="flex flex-col items-center pt-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-fg" />
              {i < entries.length - 1 && (
                <div className="w-px flex-1 bg-gray-200 mt-1" />
              )}
            </div>

            <div className="flex-1 pb-1 space-y-0.5 min-w-0">
              <p className="text-[11px] font-mono">
                <span>{entry.event}</span>
                <span className="text-gray-400"> by </span>
                <span className="break-all">{displayFor(entry.from, ensMap)}</span>
                {entry.to && (
                  <>
                    <span className="text-gray-400"> → </span>
                    <span className="break-all">{displayFor(entry.to, ensMap)}</span>
                  </>
                )}
              </p>
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-mono text-gray-400">
                  {formatDate(entry.blockTime)}
                </p>
                <a
                  href={explorerTxUrl(entry.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-gray-400 hover:text-fg transition-colors"
                  aria-label="View transaction"
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
