import { NextRequest, NextResponse } from "next/server"
import { isAddress } from "viem"
import { readTokenMetadata } from "@/lib/token-metadata-store"
import { refreshTokenMetadata } from "@/lib/external-indexer"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { enqueueRefresh } from "@/lib/refresh-jobs"
import {
  DEFAULT_TOKEN_COOLDOWN_MINUTES,
  cooldownMinutes,
  publicJob,
} from "@/lib/refresh-jobs-core"

/**
 * Per-token "Refresh metadata" endpoint. Backs the button on the token page,
 * which is shown only to the token's owner or creator (client-side gate, same
 * trust model as the "Refresh my work" button — PND has no wallet-signature
 * auth). The real abuse bounds are the per-IP budget and the per-token
 * cooldown below.
 *
 * Flow: validate → per-IP budget → known token → enqueue a durable `token`
 * job in `refresh_jobs` (migration 035), refused while one is active or
 * within REFRESH_TOKEN_COOLDOWN_MINUTES (default 2) of the last one
 * finishing. The worker re-resolves tokenURI and upserts `token_metadata`.
 *
 * Responses:
 *   202 { ok: true, message, etaMinutes, job }   job enqueued
 *   404 { ok: false, error: "unknown token" }     never indexed
 *   429 { ok: false, error, reason, retryAfter, retryAfterMinutes, job? }
 *   503 { ok: false, error }                      queue unavailable
 */
const TOKEN_ID_RE = /^[0-9]+$/

function tooMany(retryAfter: number, body: Record<string, unknown>) {
  return NextResponse.json(
    {
      ok: false,
      retryAfter,
      retryAfterMinutes: Math.max(1, Math.ceil(retryAfter / 60)),
      ...body,
    },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  )
}

const QUEUED = {
  ok: true,
  message:
    "Refreshing metadata. The update usually appears within a minute — reload the page to see it.",
  etaMinutes: 1,
} as const

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ contract: string; tokenId: string }> },
) {
  // Per-IP budget, so one client cannot walk many tokens through the
  // worker in a burst.
  const rl = checkRateLimit("refresh-token", getClientIp(req), 60_000, 20)
  if (!rl.ok) return tooMany(rl.retryAfter, { error: "rate-limited", reason: "rate-limited" })

  const { contract: rawContract, tokenId: rawTokenId } = await context.params
  const contract = decodeURIComponent(rawContract).toLowerCase()
  const tokenId = decodeURIComponent(rawTokenId)

  if (!isAddress(contract) || !TOKEN_ID_RE.test(tokenId)) {
    return NextResponse.json(
      { ok: false, error: "invalid contract or tokenId" },
      { status: 400 },
    )
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

  const cooldownSeconds =
    cooldownMinutes(
      process.env.REFRESH_TOKEN_COOLDOWN_MINUTES,
      DEFAULT_TOKEN_COOLDOWN_MINUTES,
    ) * 60
  const result = await enqueueRefresh("token", `${contract}:${tokenId}`, cooldownSeconds)
  switch (result.kind) {
    case "created":
      return NextResponse.json({ ...QUEUED, job: publicJob(result.job) }, { status: 202 })
    case "refused": {
      const minutes = Math.max(1, Math.ceil(result.retryAfter / 60))
      return tooMany(result.retryAfter, {
        error:
          result.reason === "active"
            ? "A refresh for this token is already running."
            : `Recently refreshed — try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        reason: result.reason,
        job: publicJob(result.job),
      })
    }
    case "no-table": {
      // Migration 035 not applied yet: the old worker endpoint.
      const { ok } = await refreshTokenMetadata(contract, tokenId)
      return ok
        ? NextResponse.json({ ...QUEUED, job: null }, { status: 202 })
        : NextResponse.json({ ok: false, error: "worker unavailable" }, { status: 503 })
    }
    case "unavailable":
      return NextResponse.json(
        { ok: false, error: "refresh queue unavailable" },
        { status: 503 },
      )
  }
}
