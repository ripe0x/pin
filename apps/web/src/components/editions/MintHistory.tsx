/**
 * Mint history for an edition, newest first, batched by (holder, block).
 * Styled to match the auction page's bid-history list.
 */
import { type MintHistoryEntry } from "@/lib/editions-onchain"
import { evmNowAddressUrl, shortAddress } from "@/lib/pnd-editions"

export function MintHistory({
  entries,
  chainId,
}: {
  entries: MintHistoryEntry[]
  chainId: number
}) {
  if (entries.length === 0) return null
  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Mint history
      </h2>
      <ol className="space-y-2">
        {entries.map((e, i) => {
          const last = e.firstTokenId + BigInt(e.count) - 1n
          const range = e.count === 1 ? `#${e.firstTokenId}` : `#${e.firstTokenId}–#${last}`
          return (
            <li key={i} className="flex items-baseline justify-between text-[11px] font-mono">
              <a
                href={evmNowAddressUrl(e.holder, chainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-baseline gap-2 min-w-0 hover:opacity-70 transition-opacity"
              >
                <span className="truncate text-fg-muted">{shortAddress(e.holder)}</span>
                {e.mintBlock > 0n && (
                  <span className="text-fg-subtle shrink-0">block {e.mintBlock.toString()}</span>
                )}
              </a>
              <span className="tabular-nums text-fg shrink-0 ml-3">
                {range}
                {e.count > 1 ? ` · ${e.count}` : ""}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
