/**
 * Recent-mints grid for the artist's optional SovereignCollection. Shows the
 * newest tokens (ids `1..min(minted, 12)`, newest first) rendered through the
 * same sandboxed `TokenMedia` used elsewhere on the page, so onchain/HTML art
 * gets the same untrusted-iframe treatment as any auctioned token's
 * animation_url.
 *
 * Sequential id-mode only — see `recentTokenIds` in lib/collection.ts for why
 * Pooled collections can't use this "ids are 1..minted" shortcut. Pooled
 * collections render no grid at all (see the guard in the caller) rather
 * than a misleading one.
 */
import type { Address } from "viem"
import { TokenMedia } from "./TokenMedia"
import { getTokenMetadata } from "@/lib/metadata"
import { recentTokenIds } from "@/lib/sovereign-collection"

export async function CollectionTokenGrid({
  collectionAddress,
  minted,
}: {
  collectionAddress: Address
  minted: bigint
}) {
  const ids = recentTokenIds(minted, 12)
  if (ids.length === 0) return null

  const tokens = await Promise.all(
    ids.map(async (tokenId) => ({
      tokenId,
      metadata: await getTokenMetadata(collectionAddress, tokenId.toString()),
    })),
  )

  return (
    <div>
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Recent mints
      </h2>
      <div className="columns-1 sm:columns-2 lg:columns-4 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
        {tokens.map(({ tokenId, metadata }) => (
          <TokenCard key={tokenId.toString()} tokenId={tokenId} metadata={metadata} />
        ))}
      </div>
    </div>
  )
}

function TokenCard({
  tokenId,
  metadata,
}: {
  tokenId: bigint
  metadata: Awaited<ReturnType<typeof getTokenMetadata>>
}) {
  const title = metadata?.name ?? `#${tokenId.toString()}`
  return (
    <div className="group relative border border-gray-200 transition-colors hover:border-gray-400">
      <div className="aspect-square overflow-hidden bg-gray-100 flex items-center justify-center [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_video]:h-full [&_video]:w-full [&_video]:object-cover [&_iframe]:h-full [&_iframe]:w-full">
        <TokenMedia
          image={metadata?.imageSmall ?? metadata?.image ?? null}
          animationUrl={metadata?.animationUrl}
          title={title}
        />
      </div>
      <div className="px-3 py-2.5 bg-surface-muted border-t border-gray-100">
        <p className="text-[11px] font-mono text-fg tracking-tight truncate leading-none">
          {title}
        </p>
      </div>
    </div>
  )
}
