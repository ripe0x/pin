import { NextRequest, NextResponse } from "next/server"
import {
  isKnownArtist,
  refreshArtist,
  getMostRecentRefreshTime,
  countArtistTokens,
  hasUnscannedPlatform,
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
  //
  // Bypass: artists who haven't been scanned at least once on every
  // platform (any cursor still null) skip the cooldown so they can
  // catch up across multiple back-to-back clicks. After every cursor is
  // non-null, the cooldown takes over.
  const catchingUp = await hasUnscannedPlatform(address)
  const lastRefresh = catchingUp ? null : await getMostRecentRefreshTime(address)
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

  // Snapshot counts BEFORE the scan so we can report only the delta
  // ("found 3 new tokens"). Otherwise the button reports the static
  // total which is misleading on a refresh that found nothing new.
  const before = await countArtistTokens(address)

  // Do the scan synchronously inside this route's `maxDuration` budget.
  // Survives serverless function teardown that killed `after()`-based
  // background work on page server components.
  //
  // Note req.signal isn't passed through to the scans — if the client
  // disconnects, the work still completes (which is what we want; new
  // mints should land regardless of whether the user kept the tab open).
  void req.signal // suppress unused-var lint without binding
  const start = Date.now()
  const result = await refreshArtist(address)
  const durationMs = Date.now() - start

  const after = await countArtistTokens(address)
  const added = {
    manifold: Math.max(0, after.manifold - before.manifold),
    srv2: Math.max(0, after.srv2 - before.srv2),
    tl: Math.max(0, after.tl - before.tl),
  }
  return NextResponse.json({
    ok: true,
    durationMs,
    // Totals after the refresh:
    totals: after,
    // Delta vs pre-refresh — what the UI should highlight:
    added,
    // False when at least one platform stopped short of head due to
    // the MAX_BLOCKS_PER_SCAN budget. UI surfaces "still catching up"
    // and the cooldown stays bypassed until every cursor is non-null.
    caughtUp: result.caughtUp,
  })
}
