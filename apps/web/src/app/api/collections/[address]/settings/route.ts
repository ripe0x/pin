/**
 * Current owner/admin state of a collection contract, for the studio
 * Collection Settings tool to prefill. GET returns the renderer, the lock
 * states, the supply cap, royalty, cover, and the attribution roster (bigints
 * as strings). Read-only and cached via getCollection/getAttribution; every
 * change is a wallet tx the tool sends to the collection's owner-only setters.
 */

import { NextResponse } from "next/server"
import { isAddress, type Address } from "viem"
import { getCollection, getAttribution } from "@/lib/collection-onchain"
import { renderAssetsAddress } from "@/lib/collection"

type Params = { params: Promise<{ address: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Bad collection address." }, { status: 400 })
  }
  const [c, creators] = await Promise.all([
    getCollection(address as Address),
    getAttribution(address as Address),
  ])
  if (!c) {
    return NextResponse.json({ error: "Not a Surface collection." }, { status: 404 })
  }
  return NextResponse.json({
    name: c.name,
    owner: c.owner,
    renderer: c.renderer,
    isRendererLocked: c.isRendererLocked,
    isSupplyLocked: c.isSupplyLocked,
    supplyCap: c.cfg.supplyCap.toString(),
    minted: c.minted.toString(),
    royaltyBps: c.cfg.royaltyBps,
    royaltyReceiver: c.cfg.royaltyReceiver,
    cover: c.cover,
    // RenderAssets is required for the cover setter; null when unconfigured on
    // this network (the cover section shows a deployed-guard notice).
    renderAssets: renderAssetsAddress(),
    creators: creators.map((e) => ({ creator: e.creator, confirmed: e.confirmed })),
  })
}
