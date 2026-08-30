/**
 * Mint history for a collection, newest first, batched by (holder, block).
 * Styled to match the auction page's bid-history list. Sequential-mode
 * collections show the reconstructed history; Pooled-mode collections have no
 * such reconstruction available from a web-safe read (see
 * getCollectionMintHistory's doc comment in lib/collection-onchain.ts), so
 * this renders the "not available" notice instead.
 */
import { type CollectionMintHistoryResult } from "@/lib/collection-onchain"
import { evmNowAddressUrl, evmNowTxUrl } from "@/lib/collection"
import { ArtistName } from "@/components/collections/homage/ArtistName"

/** "3h ago", "2d ago", etc. — coarse, computed at render for a mint feed. */
function formatRelativeTime(unixSeconds: number, nowSeconds: number): string {
  const diff = Math.max(0, nowSeconds - unixSeconds)
  if (diff < 60) return "just now"
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 2_592_000) return `${Math.floor(diff / 86_400)}d ago`
  if (diff < 31_536_000) return `${Math.floor(diff / 2_592_000)}mo ago`
  return `${Math.floor(diff / 31_536_000)}y ago`
}

export function CollectionMintHistory({
  history,
  chainId,
}: {
  history: CollectionMintHistoryResult
  chainId: number
}) {
  if (history.unsupported === "pooled") {
    return (
      <section className="py-5 border-b border-gray-100">
        <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
          Mint history
        </h2>
        <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
          Pooled collections mint through an authorized minter with arbitrary
          token ids, so mint history is not reconstructable from a direct
          onchain read. It will appear here once PND catches up with this
          collection.
        </p>
      </section>
    )
  }

  const entries = history.entries
  if (entries.length === 0) return null
  const now = Math.floor(Date.now() / 1000)

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
            <li key={i} className="flex items-baseline justify-between gap-3 text-[11px] font-mono">
              <a
                href={evmNowAddressUrl(e.holder, chainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 truncate text-fg-muted hover:opacity-70 transition-opacity"
              >
                <ArtistName address={e.holder} />
              </a>
              <span className="flex items-baseline gap-3 shrink-0">
                <span className="tabular-nums text-fg">
                  {range}
                  {e.count > 1 ? ` · ${e.count}` : ""}
                </span>
                {e.timestamp !== null && (
                  <span className="tabular-nums text-gray-400">{formatRelativeTime(e.timestamp, now)}</span>
                )}
                <a
                  href={evmNowTxUrl(e.txHash, chainId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-400 underline hover:text-fg"
                >
                  tx ↗
                </a>
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
