/**
 * Worker Postgres client. The worker is the ONLY writer to the
 * `artist_*`, `token_*`, `contract_*`, `ens_*` tables; web reads only.
 *
 * Pool sized for parallel scanner work — start at 10, raise if a
 * specific task becomes contention-bound (you'll see it in
 * `worker_iterations.duration_ms` first).
 */
import postgres from "postgres"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("[worker] DATABASE_URL is unset")
  process.exit(1)
}

export const sql = postgres(url, {
  ssl: "prefer",
  prepare: false,
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
})
