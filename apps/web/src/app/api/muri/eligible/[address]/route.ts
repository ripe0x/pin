import { NextRequest, NextResponse } from "next/server"
import { getMuriEligibleContracts } from "@/lib/reads"

/**
 * Manifold Creator Core contracts the given artist can mint MURI-native
 * tokens on. Pure Postgres read (indexed manifold_contracts) — no RPC. The
 * connected wallet's admin rights on a chosen contract are verified live
 * client-side before any setup/mint write.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params

  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return NextResponse.json(
      { error: "Invalid Ethereum address" },
      { status: 400 },
    )
  }

  try {
    const contracts = await getMuriEligibleContracts(address)
    return NextResponse.json(
      { address, contracts, count: contracts.length },
      {
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
        },
      },
    )
  } catch (err) {
    console.error("MURI eligibility lookup failed:", err)
    return NextResponse.json(
      { error: "Failed to load eligible contracts" },
      { status: 500 },
    )
  }
}
