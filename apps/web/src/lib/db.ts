import "server-only"
import postgres from "postgres"

/**
 * Single shared Postgres client for the web app.
 *
 * Connection pooling on serverless: `max: 2` keeps each Netlify Function
 * sandbox to a tiny pool. Netlify can spin up dozens of sandboxes under
 * burst — `max × sandboxes` has to stay under Postgres `max_connections`,
 * and we observed "sorry, too many clients already" with `max: 5`. Almost
 * every request only issues 1–2 short-lived queries, so 2 connections per
 * sandbox is plenty. If we need to grow the pool further, switch to
 * PgBouncer (Railway add-on) or Neon's pooled `?sslmode=require` URL.
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

function makeClient(): ReturnType<typeof postgres> | null {
  if (!DATABASE_URL) return null
  return postgres(DATABASE_URL, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    // Postgres prepared statements aren't useful in serverless because each
    // sandbox has its own connection pool; turn them off to skip the
    // deallocation overhead on connection close.
    prepare: false,
  })
}

export const sql: ReturnType<typeof postgres> | null =
  globalThis.__pndPgClient ?? (globalThis.__pndPgClient = makeClient())
