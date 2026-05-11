import { NextResponse } from "next/server"
import {
  getSellerListingsPayload,
  type SellerListingsPayload,
} from "@/lib/seller-listings-server"

/**
 * Multi-platform cancellable-listings API. The fan-out + caching lives in
 * `@/lib/seller-listings-server` so other server-side callers (the
 * dependency-check orchestrator) reuse the same cached path.
 */

export type { SellerListingsPayload }

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
