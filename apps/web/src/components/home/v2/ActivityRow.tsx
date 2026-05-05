import Link from "next/link"
import type { ReactNode } from "react"
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

  return (
    <li className="border-t border-gray-200 py-4 px-1">
      <div className="flex items-start gap-4">
        <span className="font-mono text-xs text-gray-400 tabular-nums w-12 shrink-0 pt-0.5">
          {formatTimeAgo(event.blockTime)}
        </span>

        <div className="h-10 w-10 shrink-0 bg-gray-100 overflow-hidden flex items-center justify-center">
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
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mediaUrl}
                  alt={tokenTitle ?? ""}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              )}
            </Link>
          ) : artistAvatarUrl ? (
            <Link href={artistHref} className="block h-full w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={artistAvatarUrl}
                alt={artistDisplayName}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </Link>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
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
      return "got first bid on"
    case "auction.settled":
      return "settled"
    case "sale.buyNow":
      return "sold"
    case "mint":
      return "minted"
  }
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

  if (event.kind === "auction.firstBid" && event.amountWei !== null) {
    parts.push(
      event.counterparty ? (
        <>
          {formatEth(event.amountWei)} from <AddressLink addr={event.counterparty} />
        </>
      ) : (
        <>{formatEth(event.amountWei)}</>
      ),
    )
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
