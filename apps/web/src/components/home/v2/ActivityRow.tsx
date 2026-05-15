import Link from "next/link"
import type { ReactNode } from "react"
import { AddressZorb } from "@/components/AddressZorb"
import { OptimizedImage } from "@/components/OptimizedImage"
import type { EnrichedActivityEvent } from "@/lib/v2-activity-types"
import { formatEth, formatTimeAgo, truncateAddress } from "./format"

type Props = {
  event: EnrichedActivityEvent
}

/**
 * Presentational row for the activity feed. Pure props, sync render —
 * works on either side of the server/client boundary. Data resolution
 * (token metadata, artist identity, media URL) happens upstream in
 * `enrichActivityEvents`. This lets the lazy-scroll loader append rows
 * client-side without an RSC round-trip per page.
 *
 * Layout: `[time] [thumb] artist verb token` on the top line; price,
 * counterparty, contracts, and tx hash on a second mono-font subline so
 * the eye-line of human-readable headlines isn't broken up by mixed
 * type. Verbs are deliberately short ("listed" / "sold" / "settled" /
 * "got first bid on") rather than the marketplace-template "opened
 * auction · reserve …" wording — feeds read better when the verb glues
 * cleanly to the token title.
 */
export function ActivityRow({ event }: Props) {
  const {
    artistDisplayName,
    artistAvatarUrl,
    counterpartyDisplayName,
    tokenTitle,
    mediaUrl,
    isVideo,
  } = event

  const tokenHref =
    event.tokenContract && event.tokenId
      ? `/${event.tokenContract}/${event.tokenId}`
      : null
  const artistHref = `/artist/${event.artist}`

  // Some events render the token title inline (listed, sold, etc.); a
  // few render only the verb (collection deploy embeds the name; house
  // deploy has no token at all).
  const showTokenTitle =
    event.kind !== "house.deployed" && event.kind !== "collection.deployed"

  // Bid events flip subject/object: the bidder is the actor. The headline
  // reads "<bidder> bid <amount> on <token> by <artist>"; the rest of
  // the row template still uses the seller (artist) for thumbnail
  // fallback so an auction's rows visually anchor to the same artwork.
  const isBidEvent =
    event.kind === "auction.firstBid" || event.kind === "auction.bid"

  return (
    <li className="border-t border-gray-200 py-4 px-1">
      <div className="flex items-start gap-4">
        <span className="font-mono text-xs text-gray-400 tabular-nums w-12 shrink-0 pt-0.5">
          {formatTimeAgo(event.blockTime)}
        </span>

        <div className="h-10 w-10 shrink-0 overflow-hidden flex items-center justify-center">
          {mediaUrl && tokenHref ? (
            <Link href={tokenHref} className="block h-full w-full">
              {isVideo ? (
                <video
                  src={mediaUrl}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-cover"
                />
              ) : (
                <OptimizedImage
                  src={mediaUrl}
                  alt={tokenTitle ?? ""}
                  width={96}
                  className="h-full w-full object-cover"
                />
              )}
            </Link>
          ) : artistAvatarUrl ? (
            <Link href={artistHref} className="block h-full w-full">
              <OptimizedImage
                src={artistAvatarUrl}
                alt={artistDisplayName}
                width={96}
                className="h-full w-full object-cover"
              />
            </Link>
          ) : (
            <Link href={artistHref} className="block h-full w-full">
              <AddressZorb
                address={event.artist}
                className="h-full w-full"
              />
            </Link>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
            {isBidEvent && event.counterparty ? (
              <BidHeadline
                event={event}
                bidderHref={`/artist/${event.counterparty}`}
                bidderDisplayName={
                  counterpartyDisplayName ?? truncateAddress(event.counterparty)
                }
                artistHref={artistHref}
                artistDisplayName={artistDisplayName}
                tokenHref={tokenHref}
                tokenTitle={tokenTitle}
              />
            ) : (
              <>
                <Link
                  href={artistHref}
                  className="font-medium hover:underline underline-offset-2"
                >
                  {artistDisplayName}
                </Link>
                <span className="text-gray-500"> {renderVerb(event)} </span>
                {showTokenTitle && tokenTitle ? (
                  tokenHref ? (
                    <Link
                      href={tokenHref}
                      className="text-fg hover:underline underline-offset-2"
                    >
                      {tokenTitle}
                    </Link>
                  ) : (
                    <span>{tokenTitle}</span>
                  )
                ) : null}
              </>
            )}
          </p>
          <Subline event={event} />
        </div>
      </div>
    </li>
  )
}

function renderVerb(event: EnrichedActivityEvent): string {
  switch (event.kind) {
    case "house.deployed":
      return "deployed an auction house"
    case "collection.deployed":
      return event.collectionName
        ? `deployed collection “${event.collectionName}”`
        : "deployed a collection"
    case "auction.opened":
      return "listed"
    case "auction.cancelled":
      return "cancelled listing of"
    case "auction.firstBid":
    case "auction.bid":
      // Bid events use the BidHeadline path in the row template — this
      // verb is only consulted as a fallback (no counterparty / unknown
      // bidder), where artist-as-subject reads least confusingly.
      return "received a bid on"
    case "auction.settled":
      return "settled"
    case "sale.buyNow":
      return "sold"
    case "mint":
      return "minted"
  }
}

/**
 * Bidder-as-subject headline for bid events. Reads
 * "<bidder> bid <amount> on <token> by <seller>" — the verb consumes
 * the amount and the seller moves to the trailing "by …" so the
 * grammatical subject is the actual actor.
 */
function BidHeadline({
  event,
  bidderHref,
  bidderDisplayName,
  artistHref,
  artistDisplayName,
  tokenHref,
  tokenTitle,
}: {
  event: EnrichedActivityEvent
  bidderHref: string
  bidderDisplayName: string
  artistHref: string
  artistDisplayName: string
  tokenHref: string | null
  tokenTitle: string | null
}) {
  return (
    <>
      <Link
        href={bidderHref}
        className="font-medium hover:underline underline-offset-2"
      >
        {bidderDisplayName}
      </Link>
      <span className="text-gray-500">
        {" "}
        bid{event.amountWei !== null ? ` ${formatEth(event.amountWei)}` : ""} on{" "}
      </span>
      {tokenTitle ? (
        tokenHref ? (
          <Link
            href={tokenHref}
            className="text-fg hover:underline underline-offset-2"
          >
            {tokenTitle}
          </Link>
        ) : (
          <span>{tokenTitle}</span>
        )
      ) : null}
      <span className="text-gray-500"> by </span>
      <Link
        href={artistHref}
        className="font-medium hover:underline underline-offset-2"
      >
        {artistDisplayName}
      </Link>
    </>
  )
}

/**
 * Per-event subline. Rendered as inline parts joined by " · " — each
 * part is a node so we can mix plain text with anchor links. Order:
 * money first, counterparty next, on-chain identifiers last.
 */
function Subline({ event }: { event: EnrichedActivityEvent }) {
  const parts: ReactNode[] = []

  if (
    (event.kind === "auction.opened" || event.kind === "auction.cancelled") &&
    event.reserveWei !== null
  ) {
    parts.push(<>{formatEth(event.reserveWei)} reserve</>)
  }

  // Bid events: amount + bidder live in the headline (BidHeadline). Only
  // surface the amount in the subline as a fallback when the bidder is
  // unknown, since in that case the headline reverts to the
  // artist-as-subject template and the amount has nowhere else to go.
  if (
    (event.kind === "auction.firstBid" || event.kind === "auction.bid") &&
    !event.counterparty &&
    event.amountWei !== null
  ) {
    parts.push(<>{formatEth(event.amountWei)}</>)
  }

  if (
    (event.kind === "auction.settled" || event.kind === "sale.buyNow") &&
    event.amountWei !== null
  ) {
    parts.push(
      event.counterparty ? (
        <>
          {formatEth(event.amountWei)} → <AddressLink addr={event.counterparty} />
        </>
      ) : (
        <>{formatEth(event.amountWei)}</>
      ),
    )
  }

  if (event.kind === "house.deployed" && event.house) {
    parts.push(<EtherscanAddress addr={event.house} />)
  }

  if (event.kind === "collection.deployed" && event.collection) {
    parts.push(<EtherscanAddress addr={event.collection} />)
  }

  if (event.txHash) {
    parts.push(<TxLink hash={event.txHash} />)
  }

  if (parts.length === 0) return null

  return (
    <p className="font-mono text-[11px] text-gray-400 mt-1 truncate">
      {parts.map((part, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i}>
          {i > 0 ? " · " : null}
          {part}
        </span>
      ))}
    </p>
  )
}

/** Truncated address linked to the artist page. Used for counterparties
 * (bidders, buyers, winners) so the click goes to their portfolio
 * rather than off-site to Etherscan. */
function AddressLink({ addr }: { addr: string }) {
  return (
    <Link
      href={`/artist/${addr}`}
      className="hover:text-fg transition-colors"
    >
      {truncateAddress(addr)}
    </Link>
  )
}

/** Truncated address linked to Etherscan. Used for contract addresses
 * (auction houses, collections) where the on-chain page is the useful
 * destination. */
function EtherscanAddress({ addr }: { addr: string }) {
  return (
    <a
      href={`https://etherscan.io/address/${addr}`}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-fg transition-colors"
    >
      {truncateAddress(addr)}
    </a>
  )
}

function TxLink({ hash }: { hash: string }) {
  return (
    <a
      href={`https://etherscan.io/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-fg transition-colors"
    >
      view tx ↗
    </a>
  )
}
