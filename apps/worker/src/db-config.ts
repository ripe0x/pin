/**
 * Worker Postgres session settings (audit L6). Pure, so the env parsing
 * is unit-testable without DATABASE_URL (db.ts exits when it's unset).
 *
 * statement_timeout: no worker query should run for minutes. Without a
 * cap, one pathological query (a seq scan gone wrong, a lock wait) holds
 * a pool slot and the task's single-flight flag indefinitely, which the
 * per-task health check then reports as stuck. 30s by default; override
 * with WORKER_STATEMENT_TIMEOUT_MS (0 disables). Migrations run through
 * db/migrate.mjs on their own connection and are not affected.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000

export function statementTimeoutMs(
  env: string | undefined = process.env.WORKER_STATEMENT_TIMEOUT_MS,
): number {
  if (env === undefined || env.trim() === "") return DEFAULT_STATEMENT_TIMEOUT_MS
  const n = Number(env)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_STATEMENT_TIMEOUT_MS
}

/** Startup parameters for postgres.js' `connection` option. */
export function connectionParameters(
  env: string | undefined = process.env.WORKER_STATEMENT_TIMEOUT_MS,
): { application_name: string; statement_timeout?: number } {
  const ms = statementTimeoutMs(env)
  return ms > 0
    ? { application_name: "pnd-worker", statement_timeout: ms }
    : { application_name: "pnd-worker" }
}
