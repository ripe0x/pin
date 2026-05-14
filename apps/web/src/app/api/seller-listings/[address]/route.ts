import { NextResponse } from "next/server"
import {
  getSellerListingsPayload,
  type SellerListingsPayload,
} from "@/lib/seller-listings-server"

/**
 * Multi-platform cancellable-listings API. The fan-out + caching lives in
 * `@/lib/seller-listings-server` so other server-side callers (the
 * dependency-check orchestrator) reuse the same cached path without a
 * self-HTTP round-trip.
 */

export type { SellerListingsPayload }

// Tell Next.js / Netlify the route is allowed up to 26s — buys headroom
// over the per-adapter timeout (7s) for cold pgCache writes and JSON
// serialization, without inheriting the platform's default 10s ceiling.
export const maxDuration = 26

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse<SellerListingsPayload | { error: string }>> {
  const { address } = await ctx.params
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }
  const data = await getSellerListingsPayload(address.toLowerCase())
  return NextResponse.json(data)
}
