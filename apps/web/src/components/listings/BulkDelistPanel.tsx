"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import type { SellerListing } from "@/lib/seller-listings"
import { useSellerListings } from "@/lib/useSellerListings"
import { useSequentialCancel } from "@/lib/useSequentialCancel"
import { SellerListingsView } from "@/components/listings/SellerListingsView"

export function BulkDelistPanel({ artistAddress }: { artistAddress: string }) {
  const { address: connectedAddress } = useAccount()
  const isOwner =
    !!connectedAddress &&
    connectedAddress.toLowerCase() === artistAddress.toLowerCase()

  const { state, refresh, removeIds } = useSellerListings(artistAddress, {
    enabled: isOwner,
  })
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

  // After a run completes, drop done rows, clear their selection, and
  // invalidate the seller-listings cache so the next read (here or on the
  // /delist page or another tab) doesn't return the just-cancelled rows from
  // the 1h pg/L1 cache.
  useEffect(() => {
    if (status !== "done" || state.kind !== "loaded") return
    const doneIds = new Set<string>()
    for (const [id, s] of perItemStatus) {
      if (s.state === "done") doneIds.add(id)
    }
    if (doneIds.size === 0) return
    removeIds(doneIds)
    setSelected((prev) => {
      const next = new Set<string>()
      for (const id of prev) if (!doneIds.has(id)) next.add(id)
      return next
    })
    void fetch(
      `/api/seller-listings/revalidate?seller=${artistAddress.toLowerCase()}`,
      { method: "POST" },
    ).catch(() => {})
  }, [status, perItemStatus, state.kind, removeIds, artistAddress])

  if (!isOwner) return null
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <Section>
        <p className="text-sm text-gray-500">Loading your listings…</p>
      </Section>
    )
  }
  if (state.kind === "error") {
    return (
      <Section>
        <p className="text-sm text-red-500">{state.message}</p>
        <button
          onClick={refresh}
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-fg"
        >
          Try again
        </button>
      </Section>
    )
  }

  const total = state.auctions.length + state.buyNows.length
  if (total === 0) return null

  const allItems: SellerListing[] = [...state.auctions, ...state.buyNows]
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

  return (
    <Section>
      <header className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">
            Manage listings
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {total} active {total === 1 ? "listing" : "listings"} across
            third-party marketplaces
          </p>
        </div>
        <button
          onClick={toggleAll}
          disabled={isRunning}
          className="text-xs font-medium text-gray-600 hover:text-fg disabled:opacity-40"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </header>

      <SellerListingsView
        mode="interactive"
        auctions={state.auctions}
        buyNows={state.buyNows}
        meta={state.meta}
        selected={selected}
        onToggle={toggle}
        perItemStatus={perItemStatus}
        isRunning={isRunning}
      />

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
            className="text-sm font-medium px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-fg"
        >
          Refresh listings
        </button>
      )}
    </Section>
  )
}

function cancelButtonLabel(
  count: number,
  mode: "loading" | "batched" | "sequential",
): string {
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
    <div className="rounded-lg border border-gray-200 bg-surface p-5">
      {children}
    </div>
  )
}
