import "server-only"
import postgres from "postgres"

/**
 * Single shared Postgres client for the web app.
 *
 * Pool sizing is RUNTIME-AWARE because the same code runs in two very
 * different execution models:
 *
 *   - Netlify (production): serverless. Each function instance gets its
 *     OWN pool, and there can be many concurrent instances. A high
 *     per-instance `max` multiplies across the fleet and exhausts
 *     Postgres `max_connections` (we hit "too many clients" this way).
 *     On serverless we keep `max` tiny (3) + a short `idle_timeout`
 *     (20s) so idle instances release connections quickly.
 *
 *   - Railway (long-running): one process, reused across all requests.
 *     A real pool (max 10) is the right shape.
 *
 * Detection: Netlify sets `NETLIFY`; AWS Lambda sets
 * `AWS_LAMBDA_FUNCTION_NAME`. Absent both → assume long-running.
 *
 * At ~100 visits/day with ISR/CDN caching, even max:3 on serverless is
 * plenty — most requests are served from cache and never touch the DB.
 *
 * **Kill switch.** When `DATABASE_URL` is unset (e.g. on a preview deploy
 * before Postgres is provisioned, or as an explicit disable), we export
 * `null`. Callers — primarily `pgCache` — must check for null and fall
 * through to the upstream fetcher. This keeps the app working unchanged
 * before the DB is wired up, and gives ops a one-line lever to disable
 * the L2 cache layer if it ever misbehaves.
 *
 * `globalThis` cache survives HMR in dev so we don't open a fresh pool
 * on every file change.
 */

declare global {
  // eslint-disable-next-line no-var
  var __pndPgClient: ReturnType<typeof postgres> | null | undefined
}

const DATABASE_URL = process.env.DATABASE_URL

const IS_SERVERLESS =
  !!process.env.NETLIFY || !!process.env.AWS_LAMBDA_FUNCTION_NAME

function makeClient(): ReturnType<typeof postgres> | null {
  if (!DATABASE_URL) return null
  const client = postgres(DATABASE_URL, {
    // See module doc: tiny pool on serverless (many instances), real
    // pool on long-running.
    max: IS_SERVERLESS ? 3 : 10,
    idle_timeout: IS_SERVERLESS ? 20 : 30,
    connect_timeout: 10,
    // Prepared statements would be a net win for a long-running process,
    // but postgres.js has subtle TS-ergonomics issues with `prepare: true`
    // when using the template-tag interface heavily. Leave off until we
    // have a profiler-driven reason to flip.
    prepare: false,
  })

  // Best-effort graceful shutdown. On Netlify, sandboxes are usually killed
  // with SIGKILL (no signal delivered to userland), so this rarely fires in
  // production — pgbouncer logs `client unexpected eof` for those. But when
  // the runtime DOES send SIGTERM (graceful shutdown, dev hot-reload), this
  // closes connections cleanly so they don't show as `unexpected eof` in
  // pgbouncer logs.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void client.end({ timeout: 5 })
    })
  }

  return client
}

export const sql: ReturnType<typeof postgres> | null =
  globalThis.__pndPgClient ?? (globalThis.__pndPgClient = makeClient())
