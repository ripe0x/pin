"use client"

import { useCallback, useEffect, useState } from "react"
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
    }
  | { kind: "error"; message: string }

/**
 * Loads a wallet's cancellable listings across all supported platforms
 * (Foundation reserve auctions and buy-now, SuperRare V2 auctions) plus
 * the per-token display metadata (name + image).
 *
 * Shared by the owner-side interactive panel on `/artist/[address]` and
 * the public read-only preview on `/delist`. The underlying API is pg
 * cached for 5 min keyed on the lowercase address, so cold-calling for
 * arbitrary addresses on the public page is cheap.
 *
 * Pass `enabled: false` to skip the fetch entirely (e.g. when the
 * caller is gated on ownership and the visitor isn't the owner).
 */
export function useSellerListings(
  address: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [state, setState] = useState<SellerListingsState>({ kind: "idle" })

  const refresh = useCallback(async () => {
    if (!address) return
    setState({ kind: "loading" })
    try {
      const { auctions, buyNows } = await fetchSellerCancellableListings(
        address,
      )
      const all: SellerListing[] = [...auctions, ...buyNows]
      const meta = await resolveListingMetadata(all)
      setState({ kind: "loaded", auctions, buyNows, meta })
    } catch (err) {
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

  /**
   * Drop rows from the loaded state by id. Used after a cancel run to
   * remove rows whose cancel transaction confirmed, without re-fetching.
   */
  const removeIds = useCallback((ids: Set<string>) => {
    setState((prev) => {
      if (prev.kind !== "loaded") return prev
      return {
        kind: "loaded",
        auctions: prev.auctions.filter((a) => !ids.has(a.id)),
        buyNows: prev.buyNows.filter((b) => !ids.has(b.id)),
        meta: prev.meta,
      }
    })
  }, [])

  return { state, refresh, removeIds }
}
