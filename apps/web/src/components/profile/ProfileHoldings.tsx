"use client"

import Link from "next/link"
import { useState } from "react"
import { formatEther } from "viem"
import type {
  KeysetPage,
  ProfileHolding,
  ProfileTransferredWork,
} from "@/lib/profile-queries"
import { SectionHeading } from "./ProfileAvailable"

export function ProfileHoldings({
  address,
  initialPage,
}: {
  address: string
  initialPage: KeysetPage<ProfileHolding>
}) {
  const [page, setPage] = useState(initialPage)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (page.items.length === 0) return null

  async function loadMore() {
    if (!page.nextCursor || loading) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/profile/${address}/holdings?cursor=${encodeURIComponent(page.nextCursor)}&limit=24`,
      )
      if (!response.ok) throw new Error("Could not load more collected work")
      const next = await response.json() as KeysetPage<ProfileHolding>
      setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load more collected work")
    } finally {
      setLoading(false)
    }
  }

  return (
    <section id="collected" className="scroll-mt-20 space-y-4">
      <SectionHeading
        title="Collected"
        detail="Current ERC-721 and ERC-1155 holdings among work PND indexes. This is an evidence view, not a complete wallet inventory."
      />
      <div className="divide-y divide-gray-200 border-y border-gray-200">
        {page.items.map((item) => (
          <HoldingRow key={`${item.contract}:${item.tokenId}`} item={item} />
        ))}
      </div>
      <LoadMoreButton
        cursor={page.nextCursor}
        loading={loading}
        error={error}
        onClick={loadMore}
      />
    </section>
  )
}

function HoldingRow({ item }: { item: ProfileHolding }) {
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:px-2">
      <div className="min-w-0">
        <Link href={`/${item.contract}/${item.tokenId}`} className="truncate text-sm font-medium hover:underline">
          {item.title}
        </Link>
        <p className="font-mono text-[10px] text-gray-500">
          {item.tokenStandard.toUpperCase()}
          {item.tokenStandard === "erc1155" ? ` · balance ${item.balance}` : ""}
          {item.platform ? ` · ${item.platform}` : ""}
        </p>
        {item.creator && (
          <p className="text-[11px] text-gray-500">
            Attributed creator{" "}
            <Link href={`/profile/${item.creator}`} className="font-mono hover:text-fg">
              {shortAddress(item.creator)}
            </Link>
          </p>
        )}
      </div>
      <EvidenceLabel
        source={item.ownershipSource}
        coverage={item.coverageStatus}
        finalized={item.finalized}
        observedAt={item.observedAt}
      />
    </div>
  )
}

export function ProfileTransferredArchive({
  address,
  initialPage,
}: {
  address: string
  initialPage: KeysetPage<ProfileTransferredWork>
}) {
  const [page, setPage] = useState(initialPage)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (page.items.length === 0) return null

  async function loadMore() {
    if (!page.nextCursor || loading) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/profile/${address}/transferred?cursor=${encodeURIComponent(page.nextCursor)}&limit=24`,
      )
      if (!response.ok) throw new Error("Could not load more transfer evidence")
      const next = await response.json() as KeysetPage<ProfileTransferredWork>
      setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load more transfer evidence")
    } finally {
      setLoading(false)
    }
  }

  return (
    <section id="archive" className="scroll-mt-20 space-y-4">
      <SectionHeading
        title="Sold and transferred archive"
        detail="Created work no longer held by the attributed creator, or burned. Sold means PND indexed a completed sale by this creator; a transfer alone is never presented as a sale. Evidence may be partial until creator, ownership, and market sources have materialized."
      />
      <div className="divide-y divide-gray-200 border-y border-gray-200">
        {page.items.map((item) => (
          <div key={`${item.contract}:${item.tokenId}`} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:px-2">
            <div className="min-w-0">
              <Link href={`/${item.contract}/${item.tokenId}`} className="truncate text-sm font-medium hover:underline">
                {item.title}
              </Link>
              <p className="font-mono text-[10px] text-gray-500">
                {item.platform} · {item.state}
                {item.currentOwner && item.state !== "burned" ? ` · now ${shortAddress(item.currentOwner)}` : ""}
              </p>
              {item.state === "sold" && item.salePrice && (
                <p className="text-[11px] text-gray-500">
                  {formatEther(BigInt(item.salePrice))} ETH via {item.saleSource}
                  {item.saleBuyer ? ` · buyer ${shortAddress(item.saleBuyer)}` : ""}
                  {item.saleTxHash ? (
                    <> · <a
                      href={`https://etherscan.io/tx/${item.saleTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-fg hover:underline"
                    >settlement</a></>
                  ) : ""}
                </p>
              )}
            </div>
            <EvidenceLabel
              source="ownership evidence"
              coverage={item.ownershipCoverage ?? "snapshot"}
              finalized={item.ownershipFinalized ?? false}
              observedAt={item.ownershipObservedAt}
            />
          </div>
        ))}
      </div>
      <LoadMoreButton
        cursor={page.nextCursor}
        loading={loading}
        error={error}
        onClick={loadMore}
      />
    </section>
  )
}

function EvidenceLabel({
  source,
  coverage,
  finalized,
  observedAt,
}: {
  source: string
  coverage: string
  finalized: boolean
  observedAt: string | null
}) {
  return (
    <p className="font-mono text-[10px] text-gray-500 sm:text-right">
      {source} · {coverage}
      {!finalized ? " · not finalized" : ""}
      {observedAt ? <><br />observed {new Date(observedAt).toLocaleDateString()}</> : null}
    </p>
  )
}

function LoadMoreButton({
  cursor,
  loading,
  error,
  onClick,
}: {
  cursor: string | null
  loading: boolean
  error: string | null
  onClick: () => void
}) {
  return (
    <div className="space-y-2 text-center">
      {error && <p className="text-xs text-red-700">{error}</p>}
      {cursor && (
        <button
          type="button"
          onClick={onClick}
          disabled={loading}
          className="border border-gray-300 px-3 py-1.5 text-xs hover:border-gray-500 disabled:opacity-50"
        >
          {loading ? "Loading…" : error ? "Retry" : "Load more"}
        </button>
      )}
    </div>
  )
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
