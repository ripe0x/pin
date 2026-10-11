import { NextRequest, NextResponse } from "next/server"
import { isAddress } from "viem"
import { resolveMintCollection } from "@/lib/mint-collections"
import { getOwnedHomages, type OwnedHomage } from "@/lib/homage-queries"

function unavailable(): NextResponse<{ error: string }> {
  return NextResponse.json(
    { error: "indexer unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  )
}

/**
 * The outstanding homages a wallet currently holds — the "your homages"
 * discovery list for the redeem experience (Phase 4.4). Reads from the indexer
 * (`homage_tokens WHERE holder = wallet AND outstanding`), NOT a wallet-side
 * log scan. Fetched on-demand by the client component so a page view that never
 * connects a wallet makes zero reads.
 *
 * Responds 200 with the list (empty when the wallet holds none) and 503 when
 * the indexer read times out or fails, so the component can show its error
 * state instead of an empty list.
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
    if (homages === null) return unavailable()
    return NextResponse.json(
      { homages },
      { headers: { "Cache-Control": "private, max-age=15" } },
    )
  } catch {
    return unavailable()
  }
}
