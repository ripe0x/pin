/**
 * A collection's artist roster from Attribution.creatorsOf, cross-checked
 * live via the collection's isConfirmedCreator (see getAttribution's doc comment
 * in lib/collection-onchain.ts for the confirmation model). "Claimed" means
 * the artist has independently registered this collection in their own
 * Catalog record — the two-sided confirmation Attribution.sol documents.
 */
import { type AttributionEntry } from "@/lib/collection-onchain"
import { evmNowAddressUrl, shortAddress } from "@/lib/collection"

export function AttributionRoster({
  entries,
  chainId,
}: {
  entries: AttributionEntry[]
  chainId: number
}) {
  if (entries.length === 0) return null

  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Attribution
      </h2>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.creator} className="flex items-center justify-between gap-2 text-[11px] font-mono">
            <a
              href={evmNowAddressUrl(e.creator, chainId)}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-fg-muted hover:text-fg hover:opacity-70 transition-opacity"
            >
              {shortAddress(e.creator)}
            </a>
            {e.confirmed ? (
              <span className="shrink-0 px-2 py-1 text-[10px] uppercase tracking-wider border border-gray-200 text-gray-600">
                Claimed
              </span>
            ) : (
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-gray-400">
                Unclaimed
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
