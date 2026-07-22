import Link from "next/link"
import { AddressZorb } from "@/components/AddressZorb"
import { OptimizedImage } from "@/components/OptimizedImage"
import type { EnrichedMintGroup } from "@/lib/v2-activity-types"
import { formatEth, formatSpan, formatTimeAgo, truncateAddress } from "./format"

type Props = {
  group: EnrichedMintGroup
}

/**
 * One row standing for a run of mints on the same collection (see
 * lib/activity-grouping.ts for the collapse rule). Same skeleton as
 * ActivityRow — [time] [thumb] headline / subline — so a group reads as
 * one beat of the same feed, not a separate module. The row dates by its
 * newest member, so a live drop keeps a "now" timestamp and a climbing
 * count instead of burying the rest of the feed.
 *
 * Headline: "N mints of <collection> by <artist>", or "<artist> minted
 * N works" when there's no collection name to anchor on (an artist
 * batch-minting 1/1s). Subline: total ETH, a sample of minter avatars,
 * and the span the run covers.
 */
export function GroupedMintRow({ group }: Props) {
  const groupHref = group.collection
    ? `/collections/${group.collection}`
    : `/artist/${group.artist}`
  const artistHref = `/artist/${group.artist}`

  return (
    <li className="border-t border-gray-200 py-4 px-1">
      <div className="flex items-center gap-4">
        <span className="font-mono text-xs text-gray-400 tabular-nums w-12 shrink-0">
          {formatTimeAgo(group.blockTime)}
        </span>

        <div className="relative w-16 shrink-0">
          {group.mediaUrl ? (
            <>
              <Link href={groupHref} className="block w-full overflow-hidden">
                {group.isVideo ? (
                  <video
                    src={group.mediaUrl}
                    muted
                    playsInline
                    preload="metadata"
                    className="block w-full h-auto"
                  />
                ) : (
                  <OptimizedImage
                    src={group.mediaUrl}
                    alt={group.collectionName ?? ""}
                    width={160}
                    className="block w-full h-auto"
                  />
                )}
              </Link>
              <Link
                href={artistHref}
                aria-label={group.artistDisplayName}
                className="absolute -bottom-1 -right-1 h-5 w-5 overflow-hidden rounded-full ring-2 ring-bg bg-bg"
              >
                {group.artistAvatarUrl ? (
                  <OptimizedImage
                    src={group.artistAvatarUrl}
                    alt=""
                    width={48}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <AddressZorb
                    address={group.artist}
                    className="h-full w-full"
                  />
                )}
              </Link>
            </>
          ) : group.artistAvatarUrl ? (
            <Link
              href={artistHref}
              className="block w-full aspect-square overflow-hidden"
            >
              <OptimizedImage
                src={group.artistAvatarUrl}
                alt={group.artistDisplayName}
                width={120}
                className="h-full w-full object-cover"
              />
            </Link>
          ) : (
            <Link
              href={artistHref}
              className="block w-full aspect-square overflow-hidden"
            >
              <AddressZorb address={group.artist} className="h-full w-full" />
            </Link>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
            {group.collectionName ? (
              <>
                <Link
                  href={groupHref}
                  className="font-medium hover:underline underline-offset-2"
                >
                  {group.tokenCount} mints
                </Link>
                <span className="text-gray-500"> of </span>
                <Link
                  href={groupHref}
                  className="text-fg hover:underline underline-offset-2"
                >
                  {group.collectionName}
                </Link>
                <span className="text-gray-500"> by </span>
                <Link
                  href={artistHref}
                  className="font-medium hover:underline underline-offset-2"
                >
                  {group.artistDisplayName}
                </Link>
              </>
            ) : (
              <>
                <Link
                  href={artistHref}
                  className="font-medium hover:underline underline-offset-2"
                >
                  {group.artistDisplayName}
                </Link>
                <span className="text-gray-500"> minted </span>
                <Link
                  href={groupHref}
                  className="text-fg hover:underline underline-offset-2"
                >
                  {group.tokenCount} works
                </Link>
              </>
            )}
          </p>
          <div className="flex items-center gap-2 mt-1">
            {group.minters.length > 0 ? (
              <span className="flex shrink-0 -space-x-1.5">
                {group.minters.map((minter) => (
                  <Link
                    key={minter.address}
                    href={`/artist/${minter.address}`}
                    aria-label={
                      minter.displayName ?? truncateAddress(minter.address)
                    }
                    className="h-4 w-4 overflow-hidden rounded-full ring-2 ring-bg"
                  >
                    {minter.avatarUrl ? (
                      <OptimizedImage
                        src={minter.avatarUrl}
                        alt=""
                        width={32}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <AddressZorb
                        address={minter.address}
                        className="h-full w-full"
                      />
                    )}
                  </Link>
                ))}
              </span>
            ) : null}
            <p className="font-mono text-[11px] text-gray-400 truncate">
              {group.totalWei !== null && group.totalWei > 0n ? (
                <span>{formatEth(group.totalWei)} · </span>
              ) : null}
              <span>
                over {formatSpan(group.oldestBlockTime, group.blockTime)}
              </span>
            </p>
          </div>
        </div>
      </div>
    </li>
  )
}
