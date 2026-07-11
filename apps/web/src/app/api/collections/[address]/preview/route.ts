/**
 * On-demand onchain preview for renderer-native works (the wall's reroll):
 * GET ?i=<seedIndex> returns { image, animationUrl } from the renderer's
 * OPTIONAL previewURI extension. Server-cached (10 min per seed index) and
 * clamped, so a click costs at most one eth_call and repeat views cost
 * nothing.
 */

import { NextResponse } from "next/server"
import { isAddress, type Address } from "viem"
import { getCollection, getRendererPreview } from "@/lib/collection-onchain"

const MAX_SEED_INDEX = 500

export async function GET(
  req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Bad collection address." }, { status: 400 })
  }
  const url = new URL(req.url)
  const i = Number(url.searchParams.get("i") ?? "0")
  if (!Number.isInteger(i) || i < 0 || i > MAX_SEED_INDEX) {
    return NextResponse.json({ error: "Bad seed index." }, { status: 400 })
  }
  const c = await getCollection(address as Address)
  if (!c) return NextResponse.json({ error: "Not a collection." }, { status: 404 })
  const preview = await getRendererPreview(
    address as Address,
    c.renderer,
    c.minted + 1n,
    i,
  )
  if (!preview) {
    return NextResponse.json({ error: "Previews not supported." }, { status: 404 })
  }
  return NextResponse.json(preview)
}
