import { NextRequest, NextResponse } from "next/server"
import { refreshArtist } from "@/lib/external-indexer"
import { refreshMintCreators } from "@/lib/platforms/mint"

/**
 * Batch refresh endpoint for the external-platform indexer
 * (Manifold / SuperRare V2 / Transient Labs / Mint).
 *
 * Receives a list of artist addresses in the JSON body and refreshes
 * each in sequence. Sized so a typical batch fits inside Netlify's
 * ~30s HTTP edge timeout — see `apps/web/netlify/functions/
 * refresh-external-indexes-cron.ts` for the orchestrator that slices
 * `known_artists` and calls this endpoint repeatedly.
 *
 * History: this route used to iterate every known artist itself in a
 * single request, which silently 504'd at the edge as soon as the
 * artist list grew past ~10. The scheduled function now owns
 * iteration; this route handles one bounded batch at a time.
 *
 * Auth: same `REVALIDATE_SECRET` gate as the rest of /api/cron/*.
 *
 * Request body shapes:
 *   `{ "addresses": ["0x...", "0x..."] }` — refresh those artists
 *      (max 25 per call). Returns `{ ok, processed, failed, durationMs }`.
 *   `{ "action": "refresh-mint-creators" }` — re-scan the Mint Factory
 *      for new `Created` events and upsert into `mint_creators` (which
 *      feeds the `known_artists` view). Called once at the top of each
 *      cron run so new Mint deployers become "known" before the batches.
 *      Returns `{ ok, added, durationMs }`.
 */

// Netlify caps synchronous HTTP functions at 26s on Pro; keep the
// runtime budget close to the edge cap so a stuck artist surfaces
// promptly rather than hanging the whole batch.
export const maxDuration = 60

// Hard upper bound on batch size — a misconfigured caller can't
// accidentally turn this back into the all-artists-in-one-request
// shape that caused the original incident.
const MAX_BATCH = 25

type Body = { addresses?: unknown; action?: unknown }

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

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    )
  }

  if (body.action === "refresh-mint-creators") {
    const start = Date.now()
    let added = 0
    try {
      const result = await refreshMintCreators()
      added = result.added
    } catch {
      return NextResponse.json(
        { ok: false, error: "refreshMintCreators failed", durationMs: Date.now() - start },
        { status: 502 },
      )
    }
    return NextResponse.json({
      ok: true,
      added,
      durationMs: Date.now() - start,
    })
  }

  const addresses = sanitizeAddresses(body.addresses)
  if (addresses === null) {
    return NextResponse.json(
      { ok: false, error: `body.addresses must be an array of <=${MAX_BATCH} addresses` },
      { status: 400 },
    )
  }
  if (addresses.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, failed: 0, durationMs: 0 })
  }

  const start = Date.now()
  let processed = 0
  let failed = 0
  for (const addr of addresses) {
    try {
      await refreshArtist(addr)
      processed++
    } catch {
      failed++
    }
  }
  return NextResponse.json({
    ok: true,
    processed,
    failed,
    durationMs: Date.now() - start,
  })
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

function sanitizeAddresses(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > MAX_BATCH) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== "string" || !ADDRESS_RE.test(item)) return null
    out.push(item.toLowerCase())
  }
  return out
}
