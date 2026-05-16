/**
 * Netlify Scheduled Function: daily refresh of external-platform indexes
 * (Manifold / SuperRare V2 / Transient Labs / Mint).
 *
 * Schedule lives in `netlify.toml` ([functions."refresh-external-indexes-cron"]
 * schedule = "0 4 * * *"). At fire time Netlify invokes this function with
 * a 15-minute execution budget — plenty for the workload below.
 *
 * Why we don't just POST a single URL anymore
 * -------------------------------------------
 * Previous implementation made ONE `fetch()` to the Next.js cron route
 * and let that route loop over all known_artists serially. The HTTP edge
 * cuts the connection at ~30s inactivity, so as soon as `known_artists`
 * grew past ~10–15 entries the cron silently 504'd. The route's
 * `maxDuration = 300` controls how long the server can run, but does
 * nothing about the edge cutoff in front of it.
 *
 * Current shape — this function is the orchestrator
 *   1. Query `known_artists` directly from Postgres (this function has
 *      DATABASE_URL via Netlify env vars, same as the web app).
 *   2. Slice the artist list into batches of `BATCH_SIZE`.
 *   3. POST each batch to `/api/cron/refresh-external-indexes` with the
 *      addresses in the JSON body. The route refreshes them in order,
 *      one at a time, within its budget. Each batch fits under the edge
 *      timeout.
 *   4. Loop until the list is exhausted. Per-batch failures (504s,
 *      transient timeouts) are logged but don't stop the loop.
 *
 * Why batches rather than a Background Function or a Railway worker
 * -----------------------------------------------------------------
 * Pragmatic interim. After Mint/TL/SR artist-token enumeration moves
 * into Ponder (separate piece of work), this cron's only remaining job
 * is Manifold — 1 platform × ~153 artists × ~3s = ~5 minutes. At that
 * point the pagination loop here is overkill but harmless. A worker
 * service is the right long-term home if growth pushes past what
 * Netlify's 15-min scheduled-function budget covers; today we're well
 * inside that envelope.
 *
 * Env required at runtime:
 *   - `URL` (auto-set by Netlify)
 *   - `REVALIDATE_SECRET` (same secret used by other /api/cron/* routes)
 *   - `DATABASE_URL` (same Postgres the web app talks to)
 */
import postgres from "postgres"

const BATCH_SIZE = Number(process.env.CRON_REFRESH_BATCH_SIZE ?? "8")

export default async () => {
  const baseUrl = process.env.URL ?? process.env.DEPLOY_PRIME_URL
  const secret = process.env.REVALIDATE_SECRET
  const dbUrl = process.env.DATABASE_URL
  if (!baseUrl) {
    console.error("refresh-external-indexes-cron: URL env not set")
    return new Response("missing URL env", { status: 500 })
  }
  if (!secret) {
    console.error("refresh-external-indexes-cron: REVALIDATE_SECRET not set")
    return new Response("missing REVALIDATE_SECRET env", { status: 500 })
  }
  if (!dbUrl) {
    console.error("refresh-external-indexes-cron: DATABASE_URL not set")
    return new Response("missing DATABASE_URL env", { status: 500 })
  }

  // Fetch the artist list once, snapshot it for the rest of the run.
  // Sorting by address makes the iteration order deterministic for
  // anyone tailing logs; the actual ordering doesn't matter for
  // correctness because every artist gets refreshed each pass.
  const sql = postgres(dbUrl, {
    ssl: "prefer",
    prepare: false,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  })

  let artists: string[]
  try {
    const rows = (await sql`
      SELECT address FROM known_artists ORDER BY address
    `) as Array<{ address: string }>
    artists = rows.map((r) => r.address)
  } catch (err) {
    console.error("refresh-external-indexes-cron: known_artists query failed", err)
    await sql.end().catch(() => {})
    return new Response("db query failed", { status: 502 })
  } finally {
    // Hand the DB connection back before the long HTTP loop — no need
    // to hold a slot for the duration of the run.
    await sql.end().catch(() => {})
  }

  if (artists.length === 0) {
    console.log("refresh-external-indexes-cron: no known artists")
    return new Response("no artists", { status: 200 })
  }

  const runStart = Date.now()
  let totalProcessed = 0
  let totalFailed = 0
  let batchesFailed = 0
  const target = `${baseUrl}/api/cron/refresh-external-indexes?secret=${encodeURIComponent(secret)}`

  // Mint creator discovery is now handled by Ponder
  // (MintFactory:Created handler) — no per-cron-run refresh needed
  // before iterating artists.

  for (let i = 0; i < artists.length; i += BATCH_SIZE) {
    const batch = artists.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(artists.length / BATCH_SIZE)
    const batchStart = Date.now()
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses: batch }),
      })
      if (!res.ok) {
        batchesFailed++
        const body = await res.text().catch(() => "")
        console.error(
          `refresh-external-indexes-cron: batch ${batchNum}/${totalBatches} HTTP ${res.status} (${batch.length} artists, ${Date.now() - batchStart}ms): ${body.slice(0, 120)}`,
        )
        // Don't break the loop — the server-side work may have completed
        // past the edge timeout; advance to the next batch regardless.
        continue
      }
      const json = (await res.json()) as {
        ok: boolean
        processed?: number
        failed?: number
      }
      totalProcessed += json.processed ?? 0
      totalFailed += json.failed ?? 0
      console.log(
        `refresh-external-indexes-cron: batch ${batchNum}/${totalBatches} ok ` +
          `(${json.processed ?? 0} processed, ${json.failed ?? 0} failed, ${Date.now() - batchStart}ms)`,
      )
    } catch (err) {
      batchesFailed++
      console.error(
        `refresh-external-indexes-cron: batch ${batchNum}/${totalBatches} fetch failed (${Date.now() - batchStart}ms)`,
        err,
      )
    }
  }

  const summary = {
    artists: artists.length,
    batches: Math.ceil(artists.length / BATCH_SIZE),
    batchesFailed,
    totalProcessed,
    totalFailed,
    durationMs: Date.now() - runStart,
  }
  console.log("refresh-external-indexes-cron: complete", summary)
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
