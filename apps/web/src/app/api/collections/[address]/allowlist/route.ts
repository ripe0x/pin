/**
 * Allowlist publish + eligibility for a collection's canonical minter gate.
 *
 * POST { addresses, signer, signature, issuedAt, chainId } — build the OZ
 *   standard merkle tree, store the list keyed by (collection, root), return
 *   { root, count }. The collection must be a PND collection, and the body
 *   must carry an EIP-191 signature by the collection's owner or an admin
 *   over the chain, collection, root, and a recent issue time (see
 *   lib/allowlist-auth.ts). The artist then activates the root onchain with
 *   FixedPriceMinter.setAllowlistRoot; only the onchain root grants anything
 *   (see lib/allowlist.ts for the trust model).
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
import { verifyAllowlistPublish } from "@/lib/allowlist-auth"
import { allowlistRoot } from "@/lib/allowlist-tree"
import { PND_CHAIN_ID } from "@/lib/collection"
import {
  getClient,
  getCollection,
  getMinterGate,
  isCollectionAdmin,
} from "@/lib/collection-onchain"
import { rateLimitResponse } from "@/lib/rate-limit"

const ZERO_ROOT = "0x" + "0".repeat(64)

type Params = { params: Promise<{ address: string }> }

export async function POST(req: Request, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Bad collection address." }, { status: 400 })
  }
  const limited = await rateLimitResponse(req, {
    namespace: "allowlist-publish",
    windowMs: 60_000,
    max: 10,
  })
  if (limited) return limited

  const collection = await getCollection(address as Address).catch(() => null)
  if (!collection) {
    return NextResponse.json({ error: "Not a PND collection." }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 })
  }
  const b = (body ?? {}) as {
    addresses?: unknown
    signer?: unknown
    signature?: unknown
    issuedAt?: unknown
    chainId?: unknown
  }
  if (!Array.isArray(b.addresses)) {
    return NextResponse.json({ error: "Body needs an addresses array." }, { status: 400 })
  }
  const computed = allowlistRoot(b.addresses as string[])
  if ("error" in computed) return NextResponse.json({ error: computed.error }, { status: 400 })

  const client = getClient()
  const auth = await verifyAllowlistPublish(
    {
      collection: address,
      root: computed.root,
      chainId: b.chainId,
      issuedAt: b.issuedAt,
      signer: b.signer,
      signature: b.signature,
    },
    {
      expectedChainId: PND_CHAIN_ID,
      now: Date.now(),
      // The read client's verifyMessage covers EOAs and contract wallets
      // (ERC-1271), so a Safe-owned collection can publish too.
      verify: (args) => client.verifyMessage(args),
      isAuthorized: async (_c, signer) =>
        signer.toLowerCase() === collection.owner.toLowerCase() ||
        (await isCollectionAdmin(address as Address, signer)),
    },
  )
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const gate = await getMinterGate(address as Address).catch(() => null)
  const result = await publishAllowlist(address as Address, computed.list, {
    activeRoot: gate?.allowlistRoot ?? null,
  })
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
