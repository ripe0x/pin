import { NextRequest, NextResponse } from "next/server"
import { verifyMessage } from "viem"
import { sql } from "@/lib/db"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import {
  buildPermanenceMessage,
  isAddressLike,
  isFreshNonce,
  isValidPermanenceBps,
} from "@/lib/editions-permanence-writeback"

/**
 * Editions permanence writeback: after an artist deploys an edition with a
 * permanence slice, the browser records "edition <e> routes <bps> of each mint
 * to vault <v> via split <s>" so the edition page can surface it
 * (docs/editions-permanence-funding.md, Phase 1).
 *
 * Auth: ECDSA signature over a deterministic message (see
 * `lib/editions-permanence-writeback.ts`). `verifyMessage` recovers an address
 * and asserts it matches the claimed `artist`. The nonce is a unix timestamp;
 * anything older than 1 hour is rejected to bound replays.
 *
 * Trust model: self-declaration, corroborated on-chain. We do not read the
 * chain here (no RPC spend, matching the /preserve writeback). The edition page
 * only surfaces the record when the stored `split` matches the edition's actual
 * on-chain `payoutAddress` (already read at render), and anyone can verify the
 * vault is a real recipient at the claimed share on the 0xSplits split.
 */

type Body = {
  edition?: unknown
  split?: unknown
  vault?: unknown
  bps?: unknown
  artist?: unknown
  nonce?: unknown
  signature?: unknown
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<{ ok: true } | { error: string }>> {
  const ip = getClientIp(req)
  const rl = checkRateLimit("editions-permanence", ip, 60_000, 10)
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }

  // Validate every field at the boundary — never trust client input.
  if (!isAddressLike(body.edition)) {
    return NextResponse.json({ error: "invalid edition" }, { status: 400 })
  }
  if (!isAddressLike(body.split)) {
    return NextResponse.json({ error: "invalid split" }, { status: 400 })
  }
  if (!isAddressLike(body.vault)) {
    return NextResponse.json({ error: "invalid vault" }, { status: 400 })
  }
  if (!isAddressLike(body.artist)) {
    return NextResponse.json({ error: "invalid artist" }, { status: 400 })
  }
  if (!isValidPermanenceBps(body.bps)) {
    return NextResponse.json({ error: "invalid bps" }, { status: 400 })
  }
  if (body.vault.toLowerCase() === body.split.toLowerCase()) {
    return NextResponse.json({ error: "vault equals split" }, { status: 400 })
  }

  const edition = body.edition.toLowerCase()
  const split = body.split.toLowerCase()
  const vault = body.vault.toLowerCase()
  const artist = body.artist.toLowerCase()
  const bps = body.bps

  const nonce = typeof body.nonce === "number" ? body.nonce : NaN
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!isFreshNonce(nonce, nowSeconds)) {
    return NextResponse.json({ error: "stale nonce" }, { status: 400 })
  }

  const signature = typeof body.signature === "string" ? body.signature : ""
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 })
  }

  const message = buildPermanenceMessage({ edition, split, vault, bps, nonce })

  // EOA verify only (no ERC-1271 RPC), matching the /preserve writeback.
  let valid: boolean
  try {
    valid = await verifyMessage({
      address: artist as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch {
    valid = false
  }
  if (!valid) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 })
  }

  if (!sql) {
    return NextResponse.json({ error: "db unavailable" }, { status: 503 })
  }

  try {
    await sql`
      INSERT INTO editions_permanence (edition, split, vault, permanence_bps, artist)
      VALUES (${edition}, ${split}, ${vault}, ${bps}, ${artist})
      ON CONFLICT (edition) DO UPDATE
        SET split          = EXCLUDED.split,
            vault          = EXCLUDED.vault,
            permanence_bps = EXCLUDED.permanence_bps,
            artist         = EXCLUDED.artist,
            created_at     = NOW()
    `
  } catch (err) {
    console.error("[editions-permanence] db error:", err)
    return NextResponse.json({ error: "db error" }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
