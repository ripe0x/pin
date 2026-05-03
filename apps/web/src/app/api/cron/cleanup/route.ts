import { NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

/**
 * Periodic cleanup endpoint. Currently prunes `rpc_events` rows older
 * than 14 days — the analytics retention window beyond which we don't
 * care about per-call detail. Runs against the same Postgres instance
 * the live app writes to; safe to call concurrently with traffic
 * (DELETE on a tiny indexed range).
 *
 * Auth: shares `REVALIDATE_SECRET` with /api/revalidate to avoid
 * proliferating one-off secrets. Hit it manually or schedule via a
 * Netlify scheduled function / external cron:
 *
 *   curl -X POST 'https://pnd.ripe.wtf/api/cron/cleanup?secret=$REVALIDATE_SECRET'
 *
 * Returns the row count pruned so the caller can log/alert if the
 * number trends suspiciously high (or stays at 0 unexpectedly).
 */

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret")
  const expected = process.env.REVALIDATE_SECRET
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "REVALIDATE_SECRET env var not set on server" },
      { status: 500 },
    )
  }
  if (secret !== expected) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    )
  }

  if (!sql) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500 },
    )
  }

  const result = await sql`
    DELETE FROM rpc_events
    WHERE ts < now() - interval '14 days'
  `
  return NextResponse.json({
    ok: true,
    pruned: { rpc_events: result.count },
  })
}
