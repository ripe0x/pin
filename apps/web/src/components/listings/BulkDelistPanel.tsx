"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { formatEther } from "viem"
import { useAccount } from "wagmi"
import {
  getSellerCancellableListings,
  resolveListingMetadata,
  type SellerListing,
  type SellerListingMeta,
  type AuctionListing,
  type BuyNowListing,
} from "@/lib/seller-listings"
import { useSequentialCancel, type ItemStatus } from "@/lib/useSequentialCancel"

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "loaded"
      auctions: AuctionListing[]
      buyNows: BuyNowListing[]
      meta: Map<string, SellerListingMeta>
    }
  | { kind: "error"; message: string }

export function BulkDelistPanel({ artistAddress }: { artistAddress: string }) {
  const { address: connectedAddress } = useAccount()
  const isOwner =
    !!connectedAddress &&
    connectedAddress.toLowerCase() === artistAddress.toLowerCase()

  const [load, setLoad] = useState<LoadState>({ kind: "idle" })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const {
    run,
    stop,
    reset,
    status,
    perItemStatus,
    mode,
    walletLabel,
  } = useSequentialCancel()

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" })
    try {
      const { auctions, buyNows } = await getSellerCancellableListings(
        artistAddress,
      )
      const all: SellerListing[] = [...auctions, ...buyNows]
      const meta = await resolveListingMetadata(all)
      setLoad({ kind: "loaded", auctions, buyNows, meta })
      setSelected(new Set())
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load listings",
      })
    }
  }, [artistAddress])

  useEffect(() => {
    if (!isOwner) return
    refresh()
  }, [isOwner, refresh])

  // After a run completes, drop done rows from the list and clear selection.
  useEffect(() => {
    if (status !== "done" || load.kind !== "loaded") return
    const stillActive = (id: string) => {
      const s = perItemStatus.get(id)
      return !s || s.state !== "done"
    }
    setLoad({
      kind: "loaded",
      auctions: load.auctions.filter((a) => stillActive(a.id)),
      buyNows: load.buyNows.filter((b) => stillActive(b.id)),
      meta: load.meta,
    })
    setSelected((prev) => {
      const next = new Set<string>()
      for (const id of prev) if (stillActive(id)) next.add(id)
      return next
    })
  }, [status, perItemStatus, load])

  if (!isOwner) return null
  if (load.kind === "idle" || load.kind === "loading") {
    return (
      <Section>
        <p className="text-sm text-gray-500">Loading your listings…</p>
      </Section>
    )
  }
  if (load.kind === "error") {
    return (
      <Section>
        <p className="text-sm text-red-500">{load.message}</p>
        <button
          onClick={refresh}
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-black"
        >
          Try again
        </button>
      </Section>
    )
  }

  const total = load.auctions.length + load.buyNows.length
  if (total === 0) return null

  const allItems: SellerListing[] = [...load.auctions, ...load.buyNows]
  const allSelected = selected.size === total
  const isRunning = status === "running"

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(allItems.map((i) => i.id)))
  }

  function handleCancel() {
    const items = allItems.filter((i) => selected.has(i.id))
    if (items.length === 0) return
    reset()
    run(items)
  }

  function statusFor(id: string): ItemStatus | undefined {
    return perItemStatus.get(id)
  }

  return (
    <Section>
      <header className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Manage listings</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {total} active FND {total === 1 ? "listing" : "listings"} on this wallet
          </p>
        </div>
        <button
          onClick={toggleAll}
          disabled={isRunning}
          className="text-xs font-medium text-gray-600 hover:text-black disabled:opacity-40"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </header>

      {load.auctions.length > 0 && (
        <Group title="Reserve auctions (no bids)">
          {load.auctions.map((a) => (
            <ListingRow
              key={a.id}
              listing={a}
              meta={load.meta.get(a.id)}
              checked={selected.has(a.id)}
              status={statusFor(a.id)}
              disabled={isRunning}
              onToggle={() => toggle(a.id)}
              priceWei={a.reserveWei}
              priceLabel="Reserve"
            />
          ))}
        </Group>
      )}

      {load.buyNows.length > 0 && (
        <Group title="Buy now">
          {load.buyNows.map((b) => (
            <ListingRow
              key={b.id}
              listing={b}
              meta={load.meta.get(b.id)}
              checked={selected.has(b.id)}
              status={statusFor(b.id)}
              disabled={isRunning}
              onToggle={() => toggle(b.id)}
              priceWei={b.priceWei}
              priceLabel="Price"
            />
          ))}
        </Group>
      )}

      <footer className="mt-5 flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
        <p className="text-xs text-gray-500">
          {selected.size} selected
          {isRunning &&
            (mode === "batched"
              ? " — sign the bundle in your wallet"
              : " — sign each cancel in your wallet")}
        </p>
        {isRunning ? (
          mode === "batched" ? (
            // Once a bundle is submitted to a smart wallet there's no
            // client-side cancel — hiding Stop avoids implying otherwise.
            <span className="text-xs text-gray-400">Working…</span>
          ) : (
            <button
              onClick={stop}
              className="text-sm font-medium px-4 py-2 border border-gray-300 hover:border-gray-500 transition-colors"
            >
              Stop
            </button>
          )
        ) : (
          <button
            onClick={handleCancel}
            disabled={selected.size === 0}
            className="text-sm font-medium px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cancelButtonLabel(selected.size, mode)}
          </button>
        )}
      </footer>

      <ModeExplainer
        mode={mode}
        walletLabel={walletLabel}
        selectedCount={selected.size}
        isRunning={isRunning}
      />

      {status === "done" && (
        <button
          onClick={refresh}
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-black"
        >
          Refresh listings
        </button>
      )}
    </Section>
  )
}

function cancelButtonLabel(count: number, mode: "loading" | "batched" | "sequential"): string {
  const noun = count === 1 ? "listing" : "listings"
  if (count === 0) return "Cancel listings"
  if (mode === "batched") return `Cancel ${count} ${noun}`
  // For sequential, signal up-front that they'll see N popups so it isn't
  // a surprise after they click.
  return `Cancel ${count} ${noun} (${count} ${count === 1 ? "signature" : "signatures"})`
}

function ModeExplainer({
  mode,
  walletLabel,
  selectedCount,
  isRunning,
}: {
  mode: "loading" | "batched" | "sequential"
  walletLabel: string | null
  selectedCount: number
  isRunning: boolean
}) {
  // Don't add chrome until there's a reason to: skip the explainer when no
  // listings are selected (the button is disabled anyway), when capabilities
  // are still loading, or while a run is in flight (the footer copy already
  // describes what's happening).
  if (mode === "loading" || selectedCount < 2 || isRunning) return null

  if (mode === "batched") {
    return (
      <p className="mt-2 text-[11px] text-gray-400">
        {walletLabel
          ? `${walletLabel} can cancel all selected listings in one signature.`
          : "Your wallet can cancel all selected listings in one signature."}
      </p>
    )
  }

  return (
    <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
      {walletLabel
        ? `${walletLabel} signs each cancel separately, so you'll see ${selectedCount} wallet popups in a row. `
        : `Your wallet signs each cancel separately, so you'll see ${selectedCount} wallet popups in a row. `}
      Smart wallets like Coinbase Smart Wallet or Safe can do this in one
      signature.
    </p>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      {children}
    </div>
  )
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
  checked,
  status,
  disabled,
  onToggle,
  priceWei,
  priceLabel,
}: {
  listing: SellerListing
  meta: SellerListingMeta | undefined
  checked: boolean
  status: ItemStatus | undefined
  disabled: boolean
  onToggle: () => void
  priceWei: bigint
  priceLabel: string
}) {
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
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={checkboxDisabled}
        className="h-4 w-4 shrink-0 accent-black disabled:opacity-40"
        aria-label={`Select ${displayName}`}
      />
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
          className="block text-sm font-medium text-gray-900 truncate hover:underline"
        >
          {displayName}
        </Link>
        <p className="text-xs text-gray-400 tabular-nums">
          {priceLabel} {formatEther(priceWei)} ETH
        </p>
      </div>
      <RowStatus status={status} />
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
      <a
        href={`https://etherscan.io/tx/${status.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
        className={`${base} text-amber-600 hover:underline`}
      >
        Cancelling…
      </a>
    )
  if (status.state === "done")
    return (
      <a
        href={`https://etherscan.io/tx/${status.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
        className={`${base} text-emerald-600 hover:underline`}
      >
        Cancelled
      </a>
    )
  return (
    <span className={`${base} text-red-500 max-w-[160px] truncate`} title={status.error}>
      {status.error}
    </span>
  )
}
