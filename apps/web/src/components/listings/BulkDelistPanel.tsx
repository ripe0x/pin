"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import type { SellerListing } from "@/lib/seller-listings"
import { useSellerListings } from "@/lib/useSellerListings"
import { BATCH_CHUNK_SIZE, useSequentialCancel } from "@/lib/useSequentialCancel"
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
  // the 1h pg/L1 cache. Skipped rows (pre-flight found them already
  // inactive on-chain) stay visible with their badge so the user sees why
  // nothing was signed for them — but they prove the cached listing data
  // is stale, so they trigger the revalidate too.
  useEffect(() => {
    if (status !== "done" || state.kind !== "loaded") return
    const doneIds = new Set<string>()
    let skippedCount = 0
    for (const [id, s] of perItemStatus) {
      if (s.state === "done") doneIds.add(id)
      if (s.state === "skipped") skippedCount++
    }
    if (doneIds.size === 0 && skippedCount === 0) return
    if (doneIds.size > 0) {
      removeIds(doneIds)
      setSelected((prev) => {
        const next = new Set<string>()
        for (const id of prev) if (!doneIds.has(id)) next.add(id)
        return next
      })
    }
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

  // Partial empty result: the scan didn't complete, so we can't honestly
  // say "you have no listings" — show a refresh prompt instead of
  // hiding the panel.
  if (total === 0 && state.partial) {
    return (
      <Section>
        <p className="text-sm text-gray-700">
          Marketplace scan didn&rsquo;t complete. Upstream RPC may be rate-
          limited or down.
        </p>
        <button
          onClick={refresh}
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-fg"
        >
          Try again
        </button>
      </Section>
    )
  }

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

      {state.partial && (
        <div className="mb-4 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          One of the marketplace scans didn&rsquo;t complete. The list below
          may be missing rows.{" "}
          <button
            onClick={refresh}
            className="font-medium underline hover:text-amber-700"
          >
            Refresh
          </button>
        </div>
      )}

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
              ? selected.size > BATCH_CHUNK_SIZE
                ? " — sign each batch in your wallet"
                : " — sign the bundle in your wallet"
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
            className="text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
  if (mode === "batched") {
    // Wallets cap EIP-5792 bundles (BATCH_CHUNK_SIZE calls), so a big
    // selection means several signed batches — say so before the click,
    // not after the second popup surprises them.
    const bundles = Math.ceil(count / BATCH_CHUNK_SIZE)
    return bundles > 1
      ? `Cancel ${count} ${noun} (${bundles} signatures)`
      : `Cancel ${count} ${noun}`
  }
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
    const bundles = Math.ceil(selectedCount / BATCH_CHUNK_SIZE)
    if (bundles > 1) {
      return (
        <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
          Wallets cap one signature at {BATCH_CHUNK_SIZE} cancels, so this
          runs as {bundles} signed batches. Each batch is checked onchain
          right before signing — listings that already sold or were
          cancelled elsewhere get skipped instead of failing the batch.
        </p>
      )
    }
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
