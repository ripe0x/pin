import { NextRequest, NextResponse } from "next/server"
import { refreshSuperrareV2Auctions } from "@/lib/platforms/superrareV2-scan"
import { refreshTransientAuctions } from "@/lib/platforms/transient-scan"

/**
 * Out-of-band refresh of the SR V2 + TL active-auction tables.
 *
 * The home grid is a pure Postgres read — no RPC in the request path.
 * This endpoint is the only thing that walks marketplace events and
 * calls `tokenCreator` / `owner` to backfill the artist-seller filter.
 *
 * Trigger via cron (Railway scheduled task or external scheduler).
 * Each scanner self-cooldowns; back-to-back hits are no-ops.
 *
 * Auth: optional `CRON_SECRET` env. If set, requests must include
 * `?secret=<value>` or `Authorization: Bearer <value>`.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return true
  const fromQuery = req.nextUrl.searchParams.get("secret")
  if (fromQuery && fromQuery === expected) return true
  const auth = req.headers.get("authorization")
  if (auth && auth === `Bearer ${expected}`) return true
  return false
}

async function run() {
  const started = Date.now()
  const results = await Promise.allSettled([
    refreshSuperrareV2Auctions(),
    refreshTransientAuctions(),
  ])
  return {
    ok: true,
    durationMs: Date.now() - started,
    superrareV2:
      results[0].status === "fulfilled"
        ? "ok"
        : `failed: ${(results[0].reason as Error)?.message ?? "unknown"}`,
    transient:
      results[1].status === "fulfilled"
        ? "ok"
        : `failed: ${(results[1].reason as Error)?.message ?? "unknown"}`,
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  return NextResponse.json(await run())
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  return NextResponse.json(await run())
}
