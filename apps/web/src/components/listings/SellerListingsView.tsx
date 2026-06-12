"use client"

import Link from "next/link"
import { formatEther } from "viem"
import { useThumbnailMedia } from "@/lib/use-thumbnail-media"
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

  // Always group by platform with a labeled header — even when only one
  // platform has rows, the label answers "listed where?" at a glance.
  return (
    <>
      {PLATFORM_ORDER.map((platform) => {
        const platformAuctions = auctions.filter((a) => a.platform === platform)
        const platformBuyNows = buyNows.filter((b) => b.platform === platform)
        if (platformAuctions.length === 0 && platformBuyNows.length === 0)
          return null

        return (
          <div key={platform} className="mb-5 last:mb-0">
            <p className="text-[11px] uppercase tracking-[0.08em] text-gray-500 mb-2">
              {PLATFORM_LABELS[platform]} ·{" "}
              {platformAuctions.length + platformBuyNows.length}
            </p>
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
          className="h-4 w-4 shrink-0 accent-fg disabled:opacity-40"
          aria-label={`Select ${displayName}`}
        />
      )}
      {imageUrl ? (
        <RowThumb url={imageUrl} alt={displayName} />
      ) : (
        <div className="h-10 w-10 shrink-0 bg-gray-100" />
      )}
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

/**
 * 40px row thumbnail that handles the full FND media reality: many works
 * (this artist's entire catalog) put a VIDEO file in `metadata.image` /
 * `mediaUri`, which a plain <img>/<Image> renders as a broken icon.
 * `useThumbnailMedia` is the shared escalation logic from ArtistGallery /
 * PreserveGrid: known-extension videos render as a muted <video> (the
 * browser shows the first frame as a still thumb), extension-less URLs
 * try the image gateway cascade first and escalate to <video> when it's
 * exhausted, and plain images rotate IPFS gateways on failure.
 */
function RowThumb({ url, alt }: { url: string; alt: string }) {
  const { kind, imgSrc, imgRef, onImgError, videoSrc, onVideoError } =
    useThumbnailMedia(url, 160)
  return (
    <div className="h-10 w-10 shrink-0 bg-gray-100 overflow-hidden">
      {kind === "failed" ? null : kind === "video" ? (
        <video
          src={videoSrc}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
          onError={onVideoError}
        />
      ) : (
        <img
          ref={imgRef}
          src={imgSrc}
          alt={alt}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={onImgError}
        />
      )}
    </div>
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
