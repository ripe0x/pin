import { NextRequest, NextResponse } from "next/server"
import { isKnownArtist } from "@/lib/known-artists"
import { refreshArtist } from "@/lib/external-indexer"
import {
  createRefreshJob,
  failRefreshJob,
  getRefreshJob,
} from "@/lib/refresh-jobs"

/**
 * "Refresh my work" button endpoint. In v2 this is a thin proxy — the
 * actual scan runs in the worker (`POST <WORKER_URL>/jobs/refresh-artist/...`).
 * The web app just enforces the known-artist gate, then enqueues.
 *
 * Per-artist dedup, cooldown, and status are durable in `refresh_jobs`.
 * The worker receives the job id and owns its running and terminal updates.
 *
 * Caller intent: invoked by `<RefreshButton>` on `/catalog/[address]`,
 * shown only when the connected wallet matches the artist's address.
 *
 * Response shape:
 *   202 { ok: true, job } — durable job accepted or already active
 *   403 { ok: false, error: "unknown artist" }
 *   503 { ok: false, error: "worker unavailable" }
 */
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ address: string }> },
) {
  const { address: raw } = await context.params
  const decoded = decodeURIComponent(raw)
  if (!ADDRESS_RE.test(decoded)) {
    return NextResponse.json(
      { ok: false, error: "invalid address" },
      { status: 400 },
    )
  }
  const address = decoded.toLowerCase()

  if (!(await isKnownArtist(address))) {
    return NextResponse.json(
      { ok: false, error: "unknown artist" },
      { status: 403 },
    )
  }

  const created = await createRefreshJob(address)
  if (created.kind === "unavailable") {
    return NextResponse.json(
      { ok: false, error: "refresh queue unavailable" },
      { status: 503 },
    )
  }
  if (created.kind === "rate-limited") {
    return NextResponse.json(
      {
        ok: false,
        error: "rate-limited",
        retryAfter: created.retryAfter,
      },
      {
        status: 429,
        headers: { "Retry-After": String(created.retryAfter) },
      },
    )
  }

  // A duplicate click returns the durable active job and does not enqueue a
  // second in-memory scan. The original worker claim keeps progressing.
  if (created.kind === "active") {
    return NextResponse.json(
      { ok: true, enqueued: false, job: created.job },
      { status: 202 },
    )
  }

  const report = await refreshArtist(address, created.job.id)
  if (!report.ok) {
    await failRefreshJob(created.job.id, "worker unavailable")
    // Worker unreachable / misconfigured. Surface honestly — better than
    // pretending the click worked.
    return NextResponse.json(
      { ok: false, error: "worker unavailable" },
      { status: 503 },
    )
  }

  return NextResponse.json(
    {
      ok: true,
      enqueued: report.enqueued,
      job: { ...created.job, status: report.status },
    },
    { status: 202 },
  )
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ address: string }> },
) {
  const { address: raw } = await context.params
  const decoded = decodeURIComponent(raw).toLowerCase()
  const jobId = req.nextUrl.searchParams.get("jobId")
  if (!ADDRESS_RE.test(decoded) || !jobId) {
    return NextResponse.json(
      { ok: false, error: "invalid address or job id" },
      { status: 400 },
    )
  }
  const job = await getRefreshJob(decoded, jobId)
  if (!job) {
    return NextResponse.json(
      { ok: false, error: "refresh job not found" },
      { status: 404 },
    )
  }
  return NextResponse.json(
    { ok: true, job },
    { headers: { "Cache-Control": "private, no-store" } },
  )
}
