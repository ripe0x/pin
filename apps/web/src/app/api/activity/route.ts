import { NextResponse } from "next/server"
import { getActivityFeed, type ActivityCursor } from "@/lib/indexer-queries"
import {
  enrichActivityEvents,
  serializeForWire,
  type SerializedActivityEvent,
} from "@/lib/v2-activity"

/**
 * Lazy-scroll page endpoint for the v2 activity feed.
 *
 * Query params: `before` (blockTime, decimal seconds), `beforeId`
 * (the last event's `id` for keyset tiebreak), `limit` (1–100, default
 * 50). Without `before`/`beforeId` returns the first page.
 *
 * The endpoint resolves token metadata + artist identity server-side
 * before responding so the client renders without follow-up requests.
 * Both reads are point-lookups in steady state (token_metadata is
 * pre-warmed by `apps/metadata-warmer`, ENS/EFP is pgCache + EFP HTTPS
 * with 24h TTL) — no per-request RPC fan-out.
 */
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url)
  const beforeRaw = url.searchParams.get("before")
  const beforeIdRaw = url.searchParams.get("beforeId")
  const limitRaw = url.searchParams.get("limit")

  let cursor: ActivityCursor | null = null
  if (beforeRaw && beforeIdRaw) {
    const blockTime = Number(beforeRaw)
    if (!Number.isFinite(blockTime) || blockTime < 0) {
      return NextResponse.json({ error: "invalid before" }, { status: 400 })
    }
    cursor = { blockTime, id: beforeIdRaw }
  }

  let limit = DEFAULT_LIMIT
  if (limitRaw) {
    const parsed = Number(limitRaw)
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(MAX_LIMIT, Math.floor(parsed))
    }
  }

  const events = await getActivityFeed(limit, cursor)
  if (events === null) {
    return NextResponse.json({ events: [] satisfies SerializedActivityEvent[] })
  }

  const enriched = await enrichActivityEvents(events)
  return NextResponse.json({
    events: enriched.map(serializeForWire),
  })
}
