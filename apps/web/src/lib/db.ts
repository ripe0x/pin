import "server-only"
import postgres from "postgres"

/**
 * Single shared Postgres client for the web app.
 *
 * v2 runs as a long-running Node process on Railway (not Netlify
 * serverless), so we can use a real pool. `max: 20` is sized for the
 * concurrent request rate at our scale (~100 visits/day with bursts);
 * bump if pg logs ever surface "too many clients."
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
  const client = postgres(DATABASE_URL, {
    max: 20,
    idle_timeout: 30,
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
