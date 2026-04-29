// Apply every .sql file in db/migrations/ once, tracked in a `_migrations`
// table so re-runs are no-ops. Idiomatic shape: tiny, dependency-light, safe
// to run from CI / a Netlify scheduled function / a developer's laptop.
//
// Reads DATABASE_URL from process.env. The npm script invokes this with
// `node --env-file=apps/web/.env.local` so local dev picks up the URL we
// already store there. In CI / production, set DATABASE_URL in the
// environment directly.
//
// Usage:
//   npm run db:migrate
//   DATABASE_URL=... node db/migrate.mjs

import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, "migrations")

const url = process.env.DATABASE_URL
if (!url) {
  console.error("DATABASE_URL is not set. Aborting.")
  process.exit(1)
}

const sql = postgres(url, {
  ssl: "prefer",
  prepare: false,
  max: 1,
  // Aggressive timeouts so a misconfigured URL fails fast instead of hanging
  // a CI run for minutes.
  idle_timeout: 5,
  connect_timeout: 10,
})

try {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  const applied = new Set(
    (await sql`SELECT filename FROM _migrations`).map((r) => r.filename),
  )

  // Sort lexicographically — migrations are named `001_...`, `002_...`, etc.
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort()

  let appliedThisRun = 0
  for (const filename of files) {
    if (applied.has(filename)) {
      console.log(`  skip   ${filename}`)
      continue
    }
    const body = await readFile(join(MIGRATIONS_DIR, filename), "utf8")
    // Each migration runs in its own transaction so a partial failure rolls
    // back cleanly. Re-running picks up where we left off.
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`INSERT INTO _migrations (filename) VALUES (${filename})`
    })
    console.log(`  apply  ${filename}`)
    appliedThisRun++
  }

  if (appliedThisRun === 0) {
    console.log("Up to date.")
  } else {
    console.log(`Applied ${appliedThisRun} migration(s).`)
  }
} finally {
  await sql.end()
}
