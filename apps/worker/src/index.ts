/**
 * PND v2 worker — single Node process, internal scheduler.
 *
 * Owns every periodic chain-touching task in the system. Replaces:
 *   - apps/metadata-warmer/  (folded in as warm-metadata task)
 *   - Netlify scheduled function refresh-external-indexes-cron
 *   - /api/cron/cleanup, /api/cron/indexer-drift-check
 *   - /api/refresh-artist (now a POST /jobs/refresh-artist HTTP surface)
 *
 * Web app never imports anything from this app — they communicate only via
 * Postgres (worker writes, web reads) and the small /jobs HTTP surface.
 *
 * Health/metrics on PORT (default 8080).
 */
import { startHealthServer } from "./health.ts"
import { startScheduler } from "./scheduler.ts"
import { sql } from "./db.ts"

const PORT = Number(process.env.PORT ?? "8080")

async function main(): Promise<void> {
  // Sanity: DB must be reachable; the worker is a write-only-to-Postgres
  // process, no point starting otherwise.
  if (!sql) {
    console.error("[worker] DATABASE_URL is unset — refusing to start")
    process.exit(1)
  }

  await startHealthServer(PORT)
  await startScheduler()

  // Graceful shutdown — Railway sends SIGTERM on redeploy.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, async () => {
      console.log(`[worker] received ${sig}, shutting down`)
      try {
        await sql.end({ timeout: 5 })
      } catch {
        // ignore
      }
      process.exit(0)
    })
  }
}

main().catch((err) => {
  console.error("[worker] fatal:", err)
  process.exit(1)
})
