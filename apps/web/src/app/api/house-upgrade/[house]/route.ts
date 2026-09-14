import { NextResponse } from "next/server"
import {
  getHouseUpgradeListings,
  type HouseUpgradeListing,
} from "@/lib/indexer-queries"

/**
 * Active listings on one sovereign house, split-ready for the V1 to V2
 * upgrade flow (HouseUpgradePanel). Indexer-backed; a null read (DB down,
 * not synced) returns 503 so the client shows a retry state instead of
 * an empty house.
 */

export type HouseUpgradePayload = { listings: HouseUpgradeListing[] }

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ house: string }> },
): Promise<NextResponse<HouseUpgradePayload | { error: string }>> {
  const { house } = await ctx.params
  if (!/^0x[0-9a-fA-F]{40}$/.test(house)) {
    return NextResponse.json({ error: "invalid house" }, { status: 400 })
  }
  const listings = await getHouseUpgradeListings(house)
  if (listings === null) {
    return NextResponse.json({ error: "indexer unavailable" }, { status: 503 })
  }
  return NextResponse.json({ listings })
}
