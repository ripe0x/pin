import { NextRequest, NextResponse } from "next/server"
import {
  isKnownArtist,
  refreshArtist,
  getMostRecentRefreshTime,
  countArtistTokens,
} from "@/lib/external-indexer"

/**
 * "Refresh my work" button endpoint. Re-runs the per-artist
 * external-platform scan (Manifold / SuperRare V2 / Transient Labs)
 * incrementally from each platform's `last_scanned_block` cursor.
 *
 * Cost protection:
 *   - Gate 1: `isKnownArtist(address)` — only addresses in our
 *     ecosystem can trigger any external API calls. Random addresses
 *     return 403 without spending a CU.
 *   - Gate 2: 5-minute rate limit per address, based on the most
 *     recent `last_indexed_at` across the three platform status rows.
 *     Returns 429 with `Retry-After` header.
 *
 * Caller intent: invoked by `<RefreshButton>` on `/catalog/[address]`,
 * shown only when the connected wallet matches the artist's address
 * (client-side UX gating; the server enforces the gates above).
 *
 * Response shape:
 *   200 { ok: true, durationMs, manifold, srv2, tl }  — token counts after refresh
 *   403 { ok: false, error: "unknown artist" }         — gate 1 fail
 *   429 { ok: false, error: "rate limited", retryAfter } + Retry-After header
 *   503 { ok: false, error: "db unavailable" }
 */

// Netlify Pro caps synchronous functions around 26s; this route opts
// into the longer 300s budget that the cron route already uses.
// Incremental scans typically finish in 2-5s; the budget is headroom
// for an artist's first-ever full scan (which can take 30-60s).
export const maxDuration = 300

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000

export async function POST(
  req: NextRequest,
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

  // Gate 1: known-artist allow-list.
  if (!(await isKnownArtist(address))) {
    return NextResponse.json(
      { ok: false, error: "unknown artist" },
      { status: 403 },
    )
  }

  // Gate 2: rate limit. Reject if any platform was refreshed within the
  // cooldown window. Status rows tracking `last_indexed_at` are bumped
  // on every successful scan (incremental or full).
  const lastRefresh = await getMostRecentRefreshTime(address)
  if (lastRefresh) {
    const elapsedMs = Date.now() - lastRefresh.getTime()
    if (elapsedMs < REFRESH_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil(
        (REFRESH_COOLDOWN_MS - elapsedMs) / 1000,
      )
      return new NextResponse(
        JSON.stringify({
          ok: false,
          error: "rate limited",
          retryAfter: retryAfterSec,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfterSec),
          },
        },
      )
    }
  }

  // Do the scan synchronously inside this route's `maxDuration` budget.
  // Survives serverless function teardown that killed `after()`-based
  // background work on page server components.
  //
  // Note req.signal isn't passed through to the scans — if the client
  // disconnects, the work still completes (which is what we want; new
  // mints should land regardless of whether the user kept the tab open).
  void req.signal // suppress unused-var lint without binding
  const start = Date.now()
  await refreshArtist(address)
  const durationMs = Date.now() - start

  const counts = await countArtistTokens(address)
  return NextResponse.json({ ok: true, durationMs, ...counts })
}
