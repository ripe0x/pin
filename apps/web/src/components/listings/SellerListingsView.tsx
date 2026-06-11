"use client"

import Image from "next/image"
import Link from "next/link"
import { formatEther } from "viem"
import type {
  SellerListing,
  SellerListingMeta,
  AuctionListing,
  BuyNowListing,
} from "@/lib/seller-listings"
import type { ItemStatus } from "@/lib/useSequentialCancel"
import type { PlatformId } from "@/lib/platforms/types"

// Display labels for platform-section headers, mirroring MigratePanel.
export const PLATFORM_LABELS: Record<PlatformId, string> = {
  foundation: "Foundation",
  superrareV2: "SuperRare",
  transient: "Transient",
  manifold: "Manifold",
  mint: "Mint",
  sovereign: "Sovereign Auction House",
}

export const PLATFORM_ORDER: PlatformId[] = [
  "foundation",
  "superrareV2",
  "sovereign",
  "manifold",
]

type InteractiveProps = {
  mode: "interactive"
  selected: Set<string>
  onToggle: (id: string) => void
  perItemStatus: Map<string, ItemStatus>
  isRunning: boolean
}

type ReadOnlyProps = {
  mode: "readOnly"
}

type Props = {
  auctions: AuctionListing[]
  buyNows: BuyNowListing[]
  meta: Map<string, SellerListingMeta>
} & (InteractiveProps | ReadOnlyProps)

export function SellerListingsView(props: Props) {
  const { auctions, buyNows, meta } = props

  // Single platform: keep the original "Reserve auctions / Buy now"
  // headers (less noise). Multi-platform: add a top-level platform
  // header so the sections are unambiguous.
  const platformsWithRows = PLATFORM_ORDER.filter((p) => {
    const a = auctions.some((x) => x.platform === p)
    const b = buyNows.some((x) => x.platform === p)
    return a || b
  })
  const showPlatformHeader = platformsWithRows.length > 1

  return (
    <>
      {PLATFORM_ORDER.map((platform) => {
        const platformAuctions = auctions.filter((a) => a.platform === platform)
        const platformBuyNows = buyNows.filter((b) => b.platform === platform)
        if (platformAuctions.length === 0 && platformBuyNows.length === 0)
          return null

        return (
          <div
            key={platform}
            className={showPlatformHeader ? "mb-5 last:mb-0" : ""}
          >
            {showPlatformHeader && (
              <p className="text-[11px] uppercase tracking-[0.08em] text-gray-500 mb-2">
                {PLATFORM_LABELS[platform]} ·{" "}
                {platformAuctions.length + platformBuyNows.length}
              </p>
            )}
            {platformAuctions.length > 0 && (
              <Group title="Reserve auctions (no bids)">
                {platformAuctions.map((a) => (
                  <ListingRow
                    key={a.id}
                    listing={a}
                    meta={meta.get(a.id)}
                    priceWei={a.reserveWei}
                    priceLabel="Reserve"
                    {...rowInteraction(props, a)}
                  />
                ))}
              </Group>
            )}
            {platformBuyNows.length > 0 && (
              <Group title="Buy now">
                {platformBuyNows.map((b) => (
                  <ListingRow
                    key={b.id}
                    listing={b}
                    meta={meta.get(b.id)}
                    priceWei={b.priceWei}
                    priceLabel="Price"
                    {...rowInteraction(props, b)}
                  />
                ))}
              </Group>
            )}
          </div>
        )
      })}
    </>
  )
}

type RowInteraction = {
  mode: "interactive" | "readOnly"
  checked: boolean
  status: ItemStatus | undefined
  disabled: boolean
  onToggle: (() => void) | undefined
}

function rowInteraction(props: Props, listing: SellerListing): RowInteraction {
  if (props.mode === "readOnly") {
    return {
      mode: "readOnly",
      checked: false,
      status: undefined,
      disabled: false,
      onToggle: undefined,
    }
  }
  return {
    mode: "interactive",
    checked: props.selected.has(listing.id),
    status: props.perItemStatus.get(listing.id),
    disabled: props.isRunning,
    onToggle: () => props.onToggle(listing.id),
  }
}

function Group({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-4 last:mb-0">
      <p className="text-[11px] uppercase tracking-[0.08em] text-gray-400 mb-2">
        {title}
      </p>
      <ul className="divide-y divide-gray-100 border-y border-gray-100">
        {children}
      </ul>
    </div>
  )
}

function ListingRow({
  listing,
  meta,
  priceWei,
  priceLabel,
  mode,
  checked,
  status,
  disabled,
  onToggle,
}: {
  listing: SellerListing
  meta: SellerListingMeta | undefined
  priceWei: bigint
  priceLabel: string
} & RowInteraction) {
  const tokenHref = `/${listing.nftContract}/${listing.tokenId}`
  const displayName = meta?.displayName ?? `#${listing.tokenId}`
  const imageUrl = meta?.imageUrl

  // Once a row enters the run pipeline its state is committed — disable the
  // checkbox so the user can't deselect it mid-cancel.
  const inFlight =
    status?.state === "confirming" ||
    status?.state === "mining" ||
    status?.state === "done"
  const checkboxDisabled = disabled || inFlight

  return (
    <li className="flex items-center gap-3 py-3">
      {mode === "interactive" && onToggle && (
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={checkboxDisabled}
          className="h-4 w-4 shrink-0 accent-black disabled:opacity-40"
          aria-label={`Select ${displayName}`}
        />
      )}
      <div className="h-10 w-10 shrink-0 bg-gray-100 overflow-hidden">
        {imageUrl && (
          <Image
            src={imageUrl}
            alt=""
            width={40}
            height={40}
            className="h-full w-full object-cover"
            unoptimized
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <Link
          href={tokenHref}
          // New tab: this list carries in-flight state (selections, run
          // progress) that in-place navigation would throw away.
          target="_blank"
          rel="noopener noreferrer"
          className="block text-sm font-medium text-gray-900 truncate hover:underline"
        >
          {displayName}
        </Link>
        <p className="text-xs text-gray-400 tabular-nums">
          {priceLabel} {formatEther(priceWei)} ETH
        </p>
      </div>
      {mode === "interactive" && <RowStatus status={status} />}
    </li>
  )
}

function RowStatus({ status }: { status: ItemStatus | undefined }) {
  if (!status || status.state === "idle") return null
  const base = "text-xs tabular-nums shrink-0"
  if (status.state === "confirming")
    return <span className={`${base} text-gray-500`}>Confirm…</span>
  if (status.state === "mining")
    return (
      <TxLabel
        txHash={status.txHash}
        className={`${base} text-amber-600`}
        label="Cancelling…"
      />
    )
  if (status.state === "done")
    return (
      <TxLabel
        txHash={status.txHash}
        className={`${base} text-emerald-600`}
        label="Listing cancelled"
      />
    )
  if (status.state === "skipped")
    return (
      <span
        className={`${base} text-gray-400 max-w-[200px] truncate`}
        title={status.reason}
      >
        Skipped — already inactive
      </span>
    )
  return (
    <span
      className={`${base} text-red-500 max-w-[160px] truncate`}
      title={status.error}
    >
      {status.error}
    </span>
  )
}

/**
 * Tx-linked status label. Batched (EIP-5792) runs don't always have a
 * per-call hash — render plain text rather than a link to /tx/undefined.
 */
function TxLabel({
  txHash,
  className,
  label,
}: {
  txHash: `0x${string}` | undefined
  className: string
  label: string
}) {
  if (!txHash) return <span className={className}>{label}</span>
  return (
    <a
      href={`https://evm.now/tx/${txHash}?chainId=1`}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} hover:underline`}
    >
      {label}
    </a>
  )
}
