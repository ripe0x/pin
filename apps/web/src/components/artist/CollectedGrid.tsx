"use client"

import { useState } from "react"
import { TokenCard } from "@/components/TokenCard"
import { Artwork } from "@/components/media/Artwork"
import {
  balanceLabel,
  collectedKey,
  collectedPageUrl,
  collectedProgress,
  initialCollectedState,
  mergeCollectedPage,
  parseCollectedPage,
  type CollectedCard,
  type CollectedPage,
  type CollectedState,
} from "@/lib/profile-collected"

/**
 * The profile's Collected tab (#299): current holdings among the works PND
 * indexes, newest acquisition first. The first page is server-rendered;
 * "Load more" walks the holdings API's keyset cursor. An explicit button
 * rather than infinite scroll, so loaded/total, a fetch error and Retry
 * are always visible.
 */
export function CollectedGrid({
  address,
  initialPage,
}: {
  address: string
  initialPage: CollectedPage
}) {
  const [state, setState] = useState<CollectedState>(() => initialCollectedState(initialPage))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadMore() {
    const cursor = state.nextCursor
    if (!cursor || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(collectedPageUrl(address, cursor))
      if (res.status === 429) throw new Error("Too many requests. Wait a moment, then retry.")
      if (!res.ok) throw new Error("Could not load more holdings.")
      const page = parseCollectedPage(await res.json())
      setState((prev) => mergeCollectedPage(prev, page, cursor))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more holdings.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <CoverageNote />
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {state.items.map((card) => (
          <li key={collectedKey(card)}>
            <CollectedTile card={card} />
          </li>
        ))}
      </ul>
      <div className="flex flex-col items-center gap-3 pt-2 text-center">
        <p className="text-[11px] font-mono text-gray-500" aria-live="polite">
          {collectedProgress(state.items.length, state.total)}
        </p>
        {error && (
          <p role="alert" className="text-xs text-gray-600">
            {error}
          </p>
        )}
        {state.nextCursor && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="inline-flex items-center justify-center rounded border border-fg px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-fg hover:text-bg disabled:opacity-50"
          >
            {loading ? "Loading…" : error ? "Retry" : "Load more"}
          </button>
        )}
      </div>
    </div>
  )
}

function CollectedTile({ card }: { card: CollectedCard }) {
  const title = card.title ?? `#${card.tokenId}`
  const balance = balanceLabel(card)
  return (
    <TokenCard
      href={`/${card.contract}/${card.tokenId}`}
      title={title}
      meta={
        <div className="flex items-baseline justify-between gap-2 text-[11px] font-mono text-fg-muted">
          <span className="truncate">{card.artistLabel ? `by ${card.artistLabel}` : "Artist not indexed"}</span>
          {balance && <span className="shrink-0 tabular-nums text-fg">{balance}</span>}
        </div>
      }
    >
      <div className="aspect-square overflow-hidden bg-gray-100">
        <Artwork media={card.artwork} alt={title} />
      </div>
    </TokenCard>
  )
}

export function CoverageNote() {
  return (
    <p className="text-xs text-gray-500">
      Showing works PND indexes. Holdings outside the platforms PND indexes
      are not listed, so this is not the whole wallet.
    </p>
  )
}
