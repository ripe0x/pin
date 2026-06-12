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
       * Non-null while per-token metadata (names + thumbnails) is still
       * resolving in the background. Rows are renderable immediately
       * with `#tokenId` fallbacks; `meta` fills in incrementally. Null
       * once every token has resolved.
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
 * per-token metadata fan-out is the slow part for large sellers, so the
 * hook goes to `loaded` as soon as the listings arrive and streams
 * `meta` in afterwards (see `metaProgress`).
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
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [state, setState] = useState<SellerListingsState>({ kind: "idle" })
  // Bumped on every refresh; in-flight work from a superseded run checks
  // it before touching state so two overlapping refreshes can't interleave.
  const genRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!address) return
    const gen = ++genRef.current
    setState({ kind: "loading" })
    try {
      const { auctions, buyNows, partial } =
        await fetchSellerCancellableListings(address)
      if (genRef.current !== gen) return
      const all: SellerListing[] = [...auctions, ...buyNows]

      // Render the rows now; stream names + thumbnails in behind them.
      setState({
        kind: "loaded",
        auctions,
        buyNows,
        meta: new Map(),
        partial,
        metaProgress:
          all.length > 0 ? { resolved: 0, total: all.length } : null,
      })
      if (all.length === 0) return

      const resolved = new Map<string, SellerListingMeta>()
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      const flush = (final: boolean) => {
        if (genRef.current !== gen) return
        const snapshot = new Map(resolved)
        setState((prev) =>
          prev.kind === "loaded"
            ? {
                ...prev,
                meta: snapshot,
                metaProgress: final
                  ? null
                  : { resolved: snapshot.size, total: all.length },
              }
            : prev,
        )
      }

      await resolveListingMetadata(all, {
        onItem: (id, meta) => {
          resolved.set(id, meta)
          if (flushTimer === null) {
            flushTimer = setTimeout(() => {
              flushTimer = null
              flush(false)
            }, META_FLUSH_MS)
          }
        },
      })
      if (flushTimer !== null) clearTimeout(flushTimer)
      flush(true)
    } catch (err) {
      if (genRef.current !== gen) return
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to load listings",
      })
    }
  }, [address])

  useEffect(() => {
    if (!enabled || !address) return
    refresh()
  }, [enabled, address, refresh])

  return { state, refresh }
}
