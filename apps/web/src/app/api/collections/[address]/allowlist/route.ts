/**
 * Allowlist publish + eligibility for a collection's canonical minter gate.
 *
 * POST { addresses: string[] } — build the OZ standard merkle tree, store
 *   the list keyed by (collection, root), return { root, count }. The
 *   artist then activates it onchain with FixedPriceMinter.setAllowlistRoot
 *   — storage is permissionless because only the onchain root grants
 *   anything (see lib/allowlist.ts for the trust model).
 *
 * GET ?wallet=0x… — eligibility of `wallet` against the root that is
 *   active onchain RIGHT NOW: { gated, eligible, proof?, root, cap }.
 *   `eligible: null` means the gate is active but no list is published
 *   for its root (the UI says so instead of guessing).
 * GET (no wallet) — gate summary { gated, root, cap, count }.
 */

import { NextResponse } from "next/server"
import { isAddress, type Address } from "viem"
import { allowlistCount, eligibilityFor, publishAllowlist } from "@/lib/allowlist"
import { getMinterGate } from "@/lib/collection-onchain"

const ZERO_ROOT = "0x" + "0".repeat(64)

type Params = { params: Promise<{ address: string }> }

export async function POST(req: Request, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Bad collection address." }, { status: 400 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 })
  }
  const addresses = (body as { addresses?: unknown })?.addresses
  if (!Array.isArray(addresses)) {
    return NextResponse.json({ error: "Body needs an addresses array." }, { status: 400 })
  }
  const result = await publishAllowlist(address as Address, addresses as string[])
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ root: result.root, count: result.count })
}

export async function GET(req: Request, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Bad collection address." }, { status: 400 })
  }
  const gate = await getMinterGate(address as Address)
  const gated = !!gate && gate.allowlistRoot.toLowerCase() !== ZERO_ROOT

  const url = new URL(req.url)
  const wallet = url.searchParams.get("wallet")

  if (!gated) {
    return NextResponse.json({
      gated: false,
      minter: gate?.minter ?? null,
      knownMinter: !!gate,
      cap: gate?.walletCap ?? "0",
    })
  }

  if (!wallet) {
    const count = await allowlistCount(address as Address, gate!.allowlistRoot)
    return NextResponse.json({
      gated: true,
      minter: gate!.minter,
      root: gate!.allowlistRoot,
      cap: gate!.walletCap,
      count,
    })
  }
  if (!isAddress(wallet)) {
    return NextResponse.json({ error: "Bad wallet address." }, { status: 400 })
  }

  const res = await eligibilityFor(address as Address, gate!.allowlistRoot, wallet as Address)
  if (!res.known) {
    return NextResponse.json({
      gated: true,
      minter: gate!.minter,
      root: gate!.allowlistRoot,
      cap: gate!.walletCap,
      eligible: null,
      reason: "no-list",
    })
  }
  return NextResponse.json({
    gated: true,
    minter: gate!.minter,
    root: gate!.allowlistRoot,
    cap: gate!.walletCap,
    eligible: res.eligible,
    proof: res.eligible ? res.proof : undefined,
  })
}
