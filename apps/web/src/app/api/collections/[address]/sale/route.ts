/**
 * Current sale config for a collection's canonical minter, for the studio
 * Sale Settings tool to prefill its forms. GET returns the minter address
 * plus the live sale fields (bigints as strings). Read-only and cached via
 * getCollection; every change is a wallet tx the tool sends directly to the
 * minter's owner-only setters.
 */

import { NextResponse } from "next/server"
import { isAddress, type Address } from "viem"
import { getCollection } from "@/lib/collection-onchain"

type Params = { params: Promise<{ address: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Bad collection address." }, { status: 400 })
  }
  const c = await getCollection(address as Address)
  if (!c) {
    return NextResponse.json({ error: "Not a Surface collection." }, { status: 404 })
  }
  const s = c.sale
  return NextResponse.json({
    minter: c.primaryMinter,
    supplyCap: c.cfg.supplyCap.toString(),
    minted: c.minted.toString(),
    sale: s
      ? {
          price: s.price.toString(),
          priceStrategy: s.priceStrategy,
          mintStart: s.mintStart.toString(),
          mintEnd: s.mintEnd.toString(),
          payout: s.payout,
          maxMints: s.maxMints.toString(),
          walletCap: s.walletCap.toString(),
          referralShareBps: s.referralShareBps,
        }
      : null,
  })
}
