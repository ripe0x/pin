import { NextResponse } from "next/server"
import { getIndexerFreshness } from "@/lib/indexer-health"
import { freshnessHttpStatus } from "@/lib/indexer-freshness-status"

/**
 * Indexer freshness check. Exposes only a block number and timestamp, so
 * no auth. 200 while the indexed schema is caught up, 503 once it falls
 * behind or freshness can't be read at all — a monitor pointed at this
 * route catches a schema pointed at a dead/frozen Ponder deployment, the
 * failure mode that let production silently serve `ponder_v1` for weeks
 * after the live schema moved to `ponder_v2`.
 */
export async function GET() {
  const freshness = await getIndexerFreshness()
  const status = freshnessHttpStatus(freshness?.ageSeconds ?? null)
  if (!freshness) {
    return NextResponse.json({ error: "indexer freshness unavailable" }, { status })
  }
  return NextResponse.json(freshness, { status })
}
