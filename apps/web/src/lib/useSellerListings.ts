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
      /** True when at least one platform adapter timed out or upstream
       * RPC failed mid-scan. Surfaces in the UI so a 0-listing result
       * during a scan failure doesn't read as a confident "nothing
       * here." Partial results are NOT persisted in pg by the route,
       * so a refresh re-runs the scan fresh. */
      partial: boolean
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
      const { auctions, buyNows, partial } =
        await fetchSellerCancellableListings(address)
      const all: SellerListing[] = [...auctions, ...buyNows]
      const meta = await resolveListingMetadata(all)
      setState({ kind: "loaded", auctions, buyNows, meta, partial })
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

  return { state, refresh }
}
