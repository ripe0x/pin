import { NextRequest, NextResponse } from "next/server"
import type { Address } from "viem"
import { getEnsUrl } from "@/lib/artist-queries"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params

  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return NextResponse.json({ error: "Invalid Ethereum address" }, { status: 400 })
  }

  const url = await getEnsUrl(address as Address)
  return NextResponse.json({ url })
}
