/**
 * A collection's owner, live admin set, and renderer-lock state, for the
 * studio Admins tool. GET-only: adding/removing an admin and locking the
 * renderer are wallet transactions the tool sends directly to the
 * collection, enforced onchain — this route only reads.
 */

import { NextResponse } from "next/server"
import { isAddress, type Address } from "viem"
import { getCollectionAuthority } from "@/lib/collection-onchain"

type Params = { params: Promise<{ address: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Bad collection address." }, { status: 400 })
  }
  const authority = await getCollectionAuthority(address as Address)
  if (!authority) {
    return NextResponse.json({ error: "Could not read this collection's authority." }, { status: 404 })
  }
  return NextResponse.json(authority)
}
