// Apply every .sql file in db/migrations/ once, tracked in a `_migrations`
// table so re-runs are no-ops. Idiomatic shape: tiny, dependency-light, safe
// to run from CI / a Railway start-up hook / a developer's laptop.
//
// Reads DATABASE_URL from process.env. The npm script invokes this with
// `node --env-file=.env` so local dev picks it up from the root .env file.
// In production, set DATABASE_URL in Railway's environment directly.
//
// Usage:
//   pnpm db:migrate
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
