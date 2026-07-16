import { NextRequest, NextResponse } from "next/server"
import { isAddress } from "viem"
import { resolveMintCollection } from "@/lib/mint-collections"
import { getOwnedHomages, type OwnedHomage } from "@/lib/homage-queries"

/**
 * The outstanding homages a wallet currently holds — the "your homages"
 * discovery list for the redeem experience (Phase 4.4). Reads from the indexer
 * (`homage_tokens WHERE holder = wallet AND outstanding`), NOT a wallet-side
 * log scan. Fetched on-demand by the client component so a page view that never
 * connects a wallet makes zero reads.
 *
 * Degrades gracefully: an absent/unsynced indexer returns `[]` (the component
 * shows an honest empty state), so this ships before the contract deploys.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ contract: string; wallet: string }> },
): Promise<NextResponse<{ homages: OwnedHomage[] } | { error: string }>> {
  const { contract, wallet } = await ctx.params
  const desc = resolveMintCollection(contract)
  if (!desc || desc.provenanceSource !== "homage") {
    return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  }
  if (!isAddress(wallet)) {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 })
  }
  try {
    const homages = await getOwnedHomages(desc.address, wallet)
    return NextResponse.json(
      { homages },
      { headers: { "Cache-Control": "private, max-age=15" } },
    )
  } catch {
    // Never surface a 500 for the discovery list — an empty list is the honest
    // degraded state (matches the query layer's own catch → []).
    return NextResponse.json({ homages: [] })
  }
}
