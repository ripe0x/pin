"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchSellerCancellableListings,
  resolveListingMetadata,
  type AuctionListing,
  type BuyNowListing,
  type SellerListing,
  type SellerListingMeta,
} from "@/lib/seller-listings"

export type SellerListingsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "loaded"
      auctions: AuctionListing[]
      buyNows: BuyNowListing[]
      meta: Map<string, SellerListingMeta>
      /** True when at least one platform adapter timed out or upstream
       * RPC failed mid-scan. Surfaces in the UI so a 0-listing result
       * during a scan failure doesn't read as a confident "nothing
       * here." Partial results are NOT persisted in pg by the route,
       * so a refresh re-runs the scan fresh. */
      partial: boolean
      /**
       * Non-null while a batch of per-token metadata (names + thumbnails)
       * is resolving — `{ resolved, total }` for that batch. Rows are
       * renderable immediately with `#tokenId` fallbacks; `meta` fills in
       * incrementally. With paginated callers the batch is one page; with
       * the default auto-resolve it's the whole set. Null when idle.
       */
      metaProgress: { resolved: number; total: number } | null
    }
  | { kind: "error"; message: string }

/** Throttle for streaming meta into React state — one re-render per
 * batch instead of one per resolved token (294 listings would
 * otherwise mean 294 re-renders of the whole list). */
const META_FLUSH_MS = 250

/**
 * Loads a wallet's cancellable listings across all supported platforms
 * (Foundation reserve auctions and buy-now, SuperRare V2 auctions) plus
 * the per-token display metadata (name + image).
 *
 * The listing set itself is one cached API call and resolves fast; the
 * per-token metadata fan-out (one `/api/meta` call + one thumbnail load
 * per token) is the slow, heavy part for large sellers. So:
 *
 *  - The hook goes to `loaded` as soon as the listing set arrives.
 *  - Metadata is resolved in throttled batches via `resolveMeta`, which
 *    skips anything already resolved and merges into `meta`.
 *  - `autoResolveMeta: true` (default) resolves the whole set in one
 *    batch — the right behavior for the read-only `/delist` preview.
 *  - `autoResolveMeta: false` leaves resolution to the caller, which is
 *    how the paginated bulk-delist panel resolves only the visible page,
 *    bounding the fan-out for artists with hundreds of listings.
 *
 * Shared by the studio listings tab and the public `/delist` page. The
 * underlying API is pg cached for 5 min keyed on the lowercase address,
 * so cold-calling for arbitrary addresses on the public page is cheap.
 *
 * Pass `enabled: false` to skip the fetch entirely (e.g. when the
 * caller is gated on ownership and the visitor isn't the owner).
 */
export function useSellerListings(
  address: string | undefined,
  {
    enabled = true,
    autoResolveMeta = true,
  }: { enabled?: boolean; autoResolveMeta?: boolean } = {},
) {
  const [state, setState] = useState<SellerListingsState>({ kind: "idle" })
  // Bumped on every refresh; in-flight work from a superseded run checks
  // it before touching state so two overlapping refreshes can't interleave.
  const genRef = useRef(0)
  // Accumulated resolved metadata across (paged) resolveMeta calls.
  // Mirrors `state.meta` but lets the resolver dedup + merge without a
  // stale closure. Reset on each refresh.
  const metaRef = useRef<Map<string, SellerListingMeta>>(new Map())
  // Bumped per resolveMeta call so that, with overlapping page batches,
  // only the most recent batch drives the visible progress bar (every
  // batch still merges its resolved metadata — that data is always good).
  const batchRef = useRef(0)

  /**
   * Resolve display metadata for `listings`, skipping any already
   * resolved, streaming results into `meta` and tracking `metaProgress`
   * for this batch. Safe to call repeatedly (e.g. per page) — disjoint
   * or overlapping subsets both behave correctly.
   */
  const resolveMeta = useCallback(async (listings: SellerListing[]) => {
    const gen = genRef.current
    const batch = ++batchRef.current
    const pending = listings.filter((l) => !metaRef.current.has(l.id))

    // Fully resolved already (e.g. revisiting a page): just clear any
    // stale progress this batch is responsible for.
    if (pending.length === 0) {
      if (genRef.current === gen && batchRef.current === batch) {
        setState((prev) =>
          prev.kind === "loaded" ? { ...prev, metaProgress: null } : prev,
        )
      }
      return
    }

    const total = pending.length
    // Push a state update: always merge the latest resolved map; only the
    // newest batch (and only if not superseded by a refresh) owns the
    // progress bar.
    const push = (resolved: number, final: boolean) => {
      if (genRef.current !== gen) return // superseded by a refresh — drop
      setState((prev) => {
        if (prev.kind !== "loaded") return prev
        const next: SellerListingsState = {
          ...prev,
          meta: new Map(metaRef.current),
        }
        if (batchRef.current === batch) {
          next.metaProgress = final ? null : { resolved, total }
        }
        return next
      })
    }

    push(0, false)
    let done = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    await resolveListingMetadata(pending, {
      onItem: (id, meta) => {
        metaRef.current.set(id, meta)
        done++
        if (flushTimer === null) {
          flushTimer = setTimeout(() => {
            flushTimer = null
            push(done, false)
          }, META_FLUSH_MS)
        }
      },
    })
    if (flushTimer !== null) clearTimeout(flushTimer)
    push(done, true)
  }, [])

  const refresh = useCallback(async () => {
    if (!address) return
    const gen = ++genRef.current
    metaRef.current = new Map()
    setState({ kind: "loading" })
    try {
      const { auctions, buyNows, partial } =
        await fetchSellerCancellableListings(address)
      if (genRef.current !== gen) return
      const all: SellerListing[] = [...auctions, ...buyNows]

      // Render the rows now; metadata streams in behind them.
      setState({
        kind: "loaded",
        auctions,
        buyNows,
        meta: new Map(),
        partial,
        metaProgress: null,
      })
      if (all.length === 0) return
      if (autoResolveMeta) void resolveMeta(all)
    } catch (err) {
      if (genRef.current !== gen) return
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to load listings",
      })
    }
  }, [address, autoResolveMeta, resolveMeta])

  useEffect(() => {
    if (!enabled || !address) return
    refresh()
  }, [enabled, address, refresh])

  return { state, refresh, resolveMeta }
}
