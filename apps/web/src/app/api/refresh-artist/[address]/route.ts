import { NextRequest, NextResponse } from "next/server"
import { isKnownArtist } from "@/lib/known-artists"
import { refreshArtist } from "@/lib/external-indexer"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { enqueueRefresh, getRefreshStatus } from "@/lib/refresh-jobs"
import {
  DEFAULT_ARTIST_COOLDOWN_MINUTES,
  cooldownMinutes,
  publicJob,
} from "@/lib/refresh-jobs-core"

/**
 * "Refresh my work" endpoint (#297). Enqueues a durable `artist` job in
 * `refresh_jobs` (migration 035); the worker claims it, runs the
 * per-artist scan, and records done/failed. The web never waits on, or
 * even talks to, the worker: the job waits in Postgres until a worker
 * picks it up, and survives worker restarts.
 *
 * Caller intent: `<RefreshButton>` on the artist's studio/catalog page,
 * shown only when the connected wallet matches the artist's address.
 *
 * POST responses:
 *   202 { ok: true, enqueued: true, job }
 *   429 { ok: false, error, reason: "active", retryAfter, job }
 *         a job for this artist is already queued or running (poll GET)
 *   429 { ok: false, error, reason: "cooldown", retryAfter, job }
 *         the last job finished under REFRESH_ARTIST_COOLDOWN_MINUTES ago
 *         (default 10)
 *   429 { ok: false, error: "rate-limited", retryAfter }   per-IP budget
 *   403 { ok: false, error: "unknown artist" }
 *   503 { ok: false, error }   queue (and legacy worker) unavailable
 *
 * GET responses (status polling):
 *   200 { ok: true, job | null }   latest job for the artist
 *
 * `retryAfter` is in seconds. Rollout: if migration 035 isn't applied
 * yet, POST falls back to the worker's legacy in-process endpoint.
 */
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

function cooldownSeconds(): number {
  return cooldownMinutes(
    process.env.REFRESH_ARTIST_COOLDOWN_MINUTES,
    DEFAULT_ARTIST_COOLDOWN_MINUTES,
  ) * 60
}

async function parseAddress(
  context: { params: Promise<{ address: string }> },
): Promise<string | null> {
  const { address: raw } = await context.params
  const decoded = decodeURIComponent(raw)
  return ADDRESS_RE.test(decoded) ? decoded.toLowerCase() : null
}

function tooMany(retryAfter: number, body: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, retryAfter, ...body },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  )
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ address: string }> },
) {
  // Per-IP budget in front of the DB work.
  const rl = checkRateLimit("refresh-artist", getClientIp(req), 60_000, 10)
  if (!rl.ok) return tooMany(rl.retryAfter, { error: "rate-limited" })

  const address = await parseAddress(context)
  if (!address) {
    return NextResponse.json(
      { ok: false, error: "invalid address" },
      { status: 400 },
    )
  }

  if (!(await isKnownArtist(address))) {
    return NextResponse.json(
      { ok: false, error: "unknown artist" },
      { status: 403 },
    )
  }

  const result = await enqueueRefresh("artist", address, cooldownSeconds())
  switch (result.kind) {
    case "created":
      return NextResponse.json(
        { ok: true, enqueued: true, job: publicJob(result.job) },
        { status: 202 },
      )
    case "refused":
      return tooMany(result.retryAfter, {
        error:
          result.reason === "active"
            ? "A refresh is already running"
            : "Refreshed recently",
        reason: result.reason,
        job: publicJob(result.job),
      })
    case "no-table": {
      // Migration 035 not applied yet: the old worker endpoint.
      const report = await refreshArtist(address)
      return report.caughtUp
        ? NextResponse.json({ ok: true, enqueued: true, job: null }, { status: 202 })
        : NextResponse.json({ ok: false, error: "worker unavailable" }, { status: 503 })
    }
    case "unavailable":
      return NextResponse.json(
        { ok: false, error: "refresh queue unavailable" },
        { status: 503 },
      )
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ address: string }> },
) {
  // Polling budget: the button polls a handful of times per click.
  const rl = checkRateLimit("refresh-artist-status", getClientIp(req), 60_000, 60)
  if (!rl.ok) return tooMany(rl.retryAfter, { error: "rate-limited" })

  const address = await parseAddress(context)
  if (!address) {
    return NextResponse.json(
      { ok: false, error: "invalid address" },
      { status: 400 },
    )
  }

  try {
    const job = await getRefreshStatus("artist", address)
    return NextResponse.json(
      { ok: true, job: job && job !== "no-table" ? publicJob(job) : null },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (err) {
    console.error("[refresh-artist] status:", err)
    return NextResponse.json(
      { ok: false, error: "status unavailable" },
      { status: 503 },
    )
  }
}
