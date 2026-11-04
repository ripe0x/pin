/**
 * Client-side fetch for the studio Sale Settings tool. Hits
 * GET /api/collections/[address]/sale (cached, server-side getCollection) so
 * the panel prefills without a per-visitor chain read. Every write is a
 * wallet tx the panel sends straight to the minter's owner-only setters.
 */

import { type Address } from "viem"
import { isNotSurfaceResponse } from "../../../lib/not-surface.ts"

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

/** Sale state, "not-surface" when the API says the address is not a PND
 *  Surface collection, null on any other failure. */
export async function fetchSaleState(
  collection: string,
): Promise<SaleState | "not-surface" | null> {
  try {
    const res = await fetch(`/api/collections/${collection.toLowerCase()}/sale`, {
      cache: "no-store",
    })
    const body = (await res.json().catch(() => null)) as unknown
    if (isNotSurfaceResponse(res.status, body)) return "not-surface"
    if (!res.ok) return null
    return body as SaleState
  } catch {
    return null
  }
}
