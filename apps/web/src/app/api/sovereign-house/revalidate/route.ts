import { NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { parseOwnerBody } from "@/lib/parse-owner-body"
import { rateLimit } from "@/lib/rate-limit"

/**
 * Bust the sovereign-house resolution cache for one owner after a house
 * deploy or upgrade confirms. Called by `useDeployHouse` and
 * `HouseUpgradePanel` once the deploy tx (or phase 1 of the V1 to V2
 * upgrade) succeeds.
 *
 * Only one layer to clear: `getSovereignHouseOf` (lib/sovereign-house.ts)
 * is `unstable_cache`-only, tagged `sov-house`. It has no pgCache (L2)
 * wrap because it reads live from Ponder's Postgres tables on every
 * cache miss, so there's no separate Postgres row to delete here.
 *
 * Unauthenticated: worst case a stranger forces a re-fetch of public
 * house-resolution data, which is what the route already does on cache
 * miss. The tag is global, so a shared per-IP rate limit bounds how often
 * one client can drop it.
 */
export async function POST(
  req: Request,
): Promise<NextResponse<{ ok: true } | { error: string; retryAfter?: number }>> {
  const rl = await rateLimit(req, { namespace: "sov-house-revalidate", windowMs: 60_000, max: 20 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }
  const body = await req.json().catch(() => null)
  const parsed = parseOwnerBody(body)
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }
  revalidateTag("sov-house")
  return NextResponse.json({ ok: true })
}
