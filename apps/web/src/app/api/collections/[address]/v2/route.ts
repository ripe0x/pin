/**
 * Live state of a primitive-first Surface v2 collection for the studio's v2
 * panels (collection settings, sale settings, mint gate), and the routing
 * answer for everything else.
 *
 * GET → SurfaceV2State (lib/surface-v2-studio.ts) for a primitive v2
 *   collection: owner, identity, the single minter, cap, royalty, the
 *   current minter read as a FixedPriceSale, and the AllowlistGate root plus
 *   the size of the list published for it. Read live, uncached: only the
 *   owner opens these panels, and each one re-reads right after a confirmed
 *   write.
 * GET → { primitiveV2: false, protocolVersion } for a v1 (or superseded
 *   August v2) Surface, so the studio keeps routing it to the v1 tools.
 * 404 { notSurface: true } for an address outside the Surface set.
 *
 * Read-only; every change is a wallet transaction the panels send.
 */

import { NextResponse } from "next/server"
import { isAddress, type Address } from "viem"
import { getSurfaceV2State } from "@/lib/collection-onchain"
import { allowlistCount } from "@/lib/allowlist"
import { NOT_SURFACE_BODY } from "@/lib/not-surface"
import { ZERO_ROOT } from "@/lib/surface-v2-studio"

type Params = { params: Promise<{ address: string }> }

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Bad collection address." }, { status: 400 })
  }
  const state = await getSurfaceV2State(address as Address).catch(() => undefined)
  if (state === undefined) {
    return NextResponse.json({ error: "Could not read this collection." }, { status: 502 })
  }
  if (state === null) return NextResponse.json(NOT_SURFACE_BODY, { status: 404 })
  if (!state.primitiveV2) return NextResponse.json(state)
  const gateListCount =
    state.gateRoot !== ZERO_ROOT
      ? await allowlistCount(address as Address, state.gateRoot).catch(() => null)
      : null
  return NextResponse.json({ ...state, gateListCount }, { headers: { "Cache-Control": "no-store" } })
}
