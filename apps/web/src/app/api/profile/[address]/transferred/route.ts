import { NextRequest, NextResponse } from "next/server"
import { decodeProfileCursor } from "@/lib/profile-cursor"
import { getProfileTransferredPage, isProfileAddress } from "@/lib/profile-queries"

export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isProfileAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 })
  }
  const cursor = request.nextUrl.searchParams.get("cursor")
  if (cursor && !decodeProfileCursor(cursor)) {
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 })
  }
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "24")
  const page = await getProfileTransferredPage(address, cursor, limit)
  return NextResponse.json(page, {
    headers: { "Cache-Control": "private, max-age=0, must-revalidate" },
  })
}
