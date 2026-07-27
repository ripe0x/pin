/**
 * Client-side fetch for the studio Sale Settings tool. Hits
 * GET /api/collections/[address]/sale (cached, server-side getCollection) so
 * the panel prefills without a per-visitor chain read. Every write is a
 * wallet tx the panel sends straight to the minter's owner-only setters.
 */

import { type Address } from "viem"

export type SaleState = {
  minter: Address | null
  supplyCap: string
  minted: string
  sale: {
    price: string
    priceStrategy: Address
    mintStart: string
    mintEnd: string
    payout: Address
    maxMints: string
    walletCap: string
    referralShareBps: number
  } | null
}

export async function fetchSaleState(collection: string): Promise<SaleState | null> {
  try {
    const res = await fetch(`/api/collections/${collection.toLowerCase()}/sale`, {
      cache: "no-store",
    })
    if (!res.ok) return null
    return (await res.json()) as SaleState
  } catch {
    return null
  }
}
