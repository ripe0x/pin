import { NextRequest, NextResponse } from "next/server"
import { isKnownArtist } from "@/lib/known-artists"
import { refreshArtist } from "@/lib/external-indexer"

/**
 * "Refresh my work" button endpoint. In v2 this is a thin proxy — the
 * actual scan runs in the worker (`POST <WORKER_URL>/jobs/refresh-artist/...`).
 * The web app just enforces the known-artist gate, then enqueues.
 *
 * Per-artist dedup + rate limiting moved to the worker (a queued artist
 * with a job in flight is a no-op enqueue on the worker side).
 *
 * Caller intent: invoked by `<RefreshButton>` on `/catalog/[address]`,
 * shown only when the connected wallet matches the artist's address.
 *
 * Response shape:
 *   202 { ok: true, enqueued: true }   — job accepted by the worker
 *   202 { ok: true, enqueued: false }  — job already in flight (dedup)
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

  const report = await refreshArtist(address)
  if (!report.caughtUp) {
    // Worker unreachable / misconfigured. Surface honestly — better than
    // pretending the click worked.
    return NextResponse.json(
      { ok: false, error: "worker unavailable" },
      { status: 503 },
    )
  }

  return NextResponse.json(
    { ok: true, enqueued: true },
    { status: 202 },
  )
}
