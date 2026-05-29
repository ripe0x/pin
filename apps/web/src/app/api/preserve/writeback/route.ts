import { NextRequest, NextResponse } from "next/server"
import { verifyMessage } from "viem"
import { sql } from "@/lib/db"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { extractBareCid } from "@/lib/metadata-host"
import {
  buildWritebackMessage,
  isFreshNonce,
  isValidProvider,
  type ProviderId,
} from "@/lib/preserve-writeback"

/**
 * /preserve writeback: artist self-declares "I pinned these CIDs at
 * <provider>" so the Artist dependency report's Preservation summary
 * can overlay an "artist personally pinned" count on top of the
 * worker-probed gateway retrievability.
 *
 * Auth: ECDSA signature over a deterministic message (see
 * `lib/preserve-writeback.ts`). `verifyMessage` recovers an address
 * from the signature and asserts it matches the claimed `artist`.
 * The nonce is a unix timestamp; we reject anything older than 1
 * hour to keep replays bounded.
 *
 * Trust model: this is SELF-DECLARATION. We do not contact the
 * pinning provider (the API key never leaves the browser by design).
 * The corroborating ground truth is `cid_availability`, populated by
 * the worker's gateway probe — see migration 018 / Phase 2a.
 */

const MAX_CIDS_PER_REQUEST = 1_000
const ALLOWED_STATUSES = new Set<string>(["pinned", "queued", "failed"])

type Body = {
  artist?: unknown
  cids?: unknown
  provider?: unknown
  status?: unknown
  nonce?: unknown
  signature?: unknown
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<{ ok: true; written: number } | { error: string }>> {
  const ip = getClientIp(req)
  const rl = checkRateLimit("preserve-writeback", ip, 60_000, 10)
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
  const artistRaw = typeof body.artist === "string" ? body.artist : ""
  if (!/^0x[0-9a-fA-F]{40}$/.test(artistRaw)) {
    return NextResponse.json({ error: "invalid artist" }, { status: 400 })
  }
  const artist = artistRaw.toLowerCase()

  const providerRaw = typeof body.provider === "string" ? body.provider : ""
  if (!isValidProvider(providerRaw)) {
    return NextResponse.json({ error: "invalid provider" }, { status: 400 })
  }
  const provider: ProviderId = providerRaw

  const status = typeof body.status === "string" ? body.status : "pinned"
  if (!ALLOWED_STATUSES.has(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 })
  }

  const cidsRaw = Array.isArray(body.cids) ? body.cids : null
  if (
    !cidsRaw ||
    cidsRaw.length === 0 ||
    cidsRaw.length > MAX_CIDS_PER_REQUEST
  ) {
    return NextResponse.json(
      { error: "invalid cids (must be 1..1000)" },
      { status: 400 },
    )
  }
  // Pass each CID through `extractBareCid` to normalise gateway URLs
  // back to bare CIDs and reject anything that doesn't look like a
  // real CID. Bare-CID strings round-trip back as themselves.
  const cids: string[] = []
  for (const c of cidsRaw) {
    if (typeof c !== "string") {
      return NextResponse.json({ error: "invalid cid entry" }, { status: 400 })
    }
    // If the client sent a gateway URL or `ipfs://`, extract the CID;
    // if the client sent a bare CID, extractBareCid won't match it
    // (it expects a URI prefix), so test the bare form first.
    const bare = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,})$/.exec(c)
      ? c
      : extractBareCid(c)
    if (!bare) {
      return NextResponse.json(
        { error: `unrecognised cid: ${c.slice(0, 24)}…` },
        { status: 400 },
      )
    }
    cids.push(bare)
  }

  const nonce = typeof body.nonce === "number" ? body.nonce : NaN
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!isFreshNonce(nonce, nowSeconds)) {
    return NextResponse.json({ error: "stale nonce" }, { status: 400 })
  }

  const signature = typeof body.signature === "string" ? body.signature : ""
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 })
  }

  const message = buildWritebackMessage({ artist, cids, provider, nonce })

  // viem's verifyMessage handles both EOA (ECDSA recover + compare)
  // and ERC-1271 (eth_sign on a smart-contract wallet) flows. The
  // 1271 path needs an RPC; default to skipping it here — the
  // overwhelming majority of artists sign from MetaMask EOAs, and we
  // don't want a writeback to incur RPC spend.
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

  // Bulk upsert. Dedup CIDs in the payload — the artist may have
  // included the same CID twice (e.g. one as metadata, one as media).
  const uniqueCids = [...new Set(cids)]
  try {
    await sql`
      INSERT INTO token_pins (artist, cid, provider, status, pinned_at)
      SELECT ${artist}, c, ${provider}, ${status}, NOW()
        FROM unnest(${uniqueCids}::text[]) AS c
      ON CONFLICT (artist, cid, provider) DO UPDATE
        SET status    = EXCLUDED.status,
            pinned_at = NOW()
    `
  } catch (err) {
    console.error("[preserve-writeback] db error:", err)
    return NextResponse.json({ error: "db error" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, written: uniqueCids.length })
}
