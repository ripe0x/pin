/**
 * Recent-mints grid for the artist's optional Surface. Shows the
 * newest tokens (ids `1..min(minted, 12)`, newest first) without issuing a
 * tokenURI request for every card during the server render. W1.3 connects
 * visible-only renderer-backed previews through the shared direct provider;
 * until then the explicit reduced state is cheaper and more honest than a
 * request-time RPC fan-out that often resolves to the same placeholder.
 *
 * Sequential id-mode only — see `recentTokenIds` in lib/collection.ts for why
 * Pooled collections can't use this "ids are 1..minted" shortcut. Pooled
 * collections render no grid at all (see the guard in the caller) rather
 * than a misleading one.
 */
import type { Address } from "viem"
import { recentTokenIds } from "@/lib/surface"

export function CollectionTokenGrid({
  collectionAddress,
  minted,
}: {
  collectionAddress: Address
  minted: bigint
}) {
  const ids = recentTokenIds(minted, 12)
  if (ids.length === 0) return null

  return (
    <div>
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Recent mints
      </h2>
      <div className="columns-1 sm:columns-2 lg:columns-4 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
        {ids.map((tokenId) => (
          <TokenCard key={`${collectionAddress}:${tokenId.toString()}`} tokenId={tokenId} />
        ))}
      </div>
    </div>
  )
}

function TokenCard({
  tokenId,
}: {
  tokenId: bigint
}) {
  const title = `#${tokenId.toString()}`
  return (
    <div className="group relative border border-gray-200 transition-colors hover:border-gray-400">
      <div className="aspect-square overflow-hidden bg-gray-100 flex items-center justify-center [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_video]:h-full [&_video]:w-full [&_video]:object-cover [&_iframe]:h-full [&_iframe]:w-full">
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray-400">
          No preview
        </span>
      </div>
      <div className="px-3 py-2.5 bg-surface-muted border-t border-gray-100">
        <p className="text-[11px] font-mono text-fg tracking-tight truncate leading-none">
          {title}
        </p>
      </div>
    </div>
  )
}
