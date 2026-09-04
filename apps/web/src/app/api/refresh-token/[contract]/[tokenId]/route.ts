import { NextRequest, NextResponse } from "next/server"
import { isAddress, verifyMessage } from "viem"
import { readTokenMetadata } from "@/lib/token-metadata-store"
import { refreshTokenMetadata } from "@/lib/external-indexer"
import {
  buildTokenRefreshMessage,
  isFreshRefreshNonce,
} from "@/lib/refresh-auth"
import { canRefreshTokenMetadata } from "@/lib/token-refresh-auth"

/**
 * Per-token "Refresh metadata" endpoint. Backs the button on the token page,
 * which is shown only to the token's owner or creator. The server verifies a
 * wallet proof and authorizes it against indexed ownership/attribution facts.
 *
 * Flow: validate → rate-limit (once per token per hour, via the stored
 * `fetched_at`) → forward to the worker, which re-resolves tokenURI and
 * upserts the `token_metadata` row.
 *
 * Responses:
 *   202 { ok: true, message, etaMinutes }      job enqueued on the worker
 *   404 { ok: false, error: "unknown token" }   token has never been indexed
 *   429 { ok: false, error, retryAfterMinutes }  refreshed within the window
 *   503 { ok: false, error: "worker unavailable" }
 */
const TOKEN_ID_RE = /^[0-9]+$/
const RATE_LIMIT_MINUTES = 60

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ contract: string; tokenId: string }> },
) {
  const { contract: rawContract, tokenId: rawTokenId } = await context.params
  const contract = decodeURIComponent(rawContract).toLowerCase()
  const tokenId = decodeURIComponent(rawTokenId)

  if (!isAddress(contract) || !TOKEN_ID_RE.test(tokenId)) {
    return NextResponse.json(
      { ok: false, error: "invalid contract or tokenId" },
      { status: 400 },
    )
  }

  const body = await req.json().catch(() => null) as {
    signer?: unknown
    nonce?: unknown
    signature?: unknown
  } | null
  const signer = typeof body?.signer === "string" ? body.signer.toLowerCase() : ""
  const nonce = typeof body?.nonce === "number" ? body.nonce : NaN
  const signature = typeof body?.signature === "string" ? body.signature : ""
  if (!isAddress(signer) || !isFreshRefreshNonce(nonce, Math.floor(Date.now() / 1000))) {
    return NextResponse.json(
      { ok: false, error: "invalid or stale refresh proof" },
      { status: 400 },
    )
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 400 })
  }
  const authenticated = await verifyMessage({
    address: signer as `0x${string}`,
    message: buildTokenRefreshMessage(signer, contract, tokenId, nonce),
    signature: signature as `0x${string}`,
  }).catch(() => false)
  if (!authenticated) {
    return NextResponse.json({ ok: false, error: "refresh proof does not match wallet" }, { status: 401 })
  }
  if (!(await canRefreshTokenMetadata(signer, contract, tokenId))) {
    return NextResponse.json({ ok: false, error: "owner or creator access required" }, { status: 403 })
  }

  // Only allow refreshing tokens the site already knows about (have a row).
  // Genuinely-new tokens are populated on first page visit via the
  // write-through path, so this also keeps the endpoint from being used to
  // warm arbitrary tokens.
  const existing = await readTokenMetadata(contract, tokenId)
  if (!existing) {
    return NextResponse.json(
      { ok: false, error: "unknown token" },
      { status: 404 },
    )
  }

  // Rate limit: one refresh per token per hour, anchored on the last fetch.
  const ageMs = Date.now() - existing.fetchedAt.getTime()
  const windowMs = RATE_LIMIT_MINUTES * 60_000
  if (ageMs < windowMs) {
    const retryAfterMinutes = Math.max(1, Math.ceil((windowMs - ageMs) / 60_000))
    return NextResponse.json(
      {
        ok: false,
        error: `Recently refreshed — try again in about ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? "" : "s"}.`,
        retryAfterMinutes,
      },
      { status: 429 },
    )
  }

  const { ok } = await refreshTokenMetadata(contract, tokenId)
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "worker unavailable" },
      { status: 503 },
    )
  }

  return NextResponse.json(
    {
      ok: true,
      message:
        "Refreshing metadata. The update usually appears within a minute — reload the page to see it.",
      etaMinutes: 1,
    },
    { status: 202 },
  )
}
