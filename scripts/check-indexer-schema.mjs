#!/usr/bin/env node
// Deploy-time guard: fail the web build if INDEXER_SCHEMA points at a
// schema that doesn't exist or has stopped being written to. This is the
// class of bug that let production silently read the dead `ponder_v1`
// schema for weeks after the live indexer moved to `ponder_v2` — nothing
// errored, the site just showed stale data. Wired as the first step of
// `apps/web`'s build script (see apps/web/package.json).
//
// Default here MUST match apps/web/src/lib/indexer-schema.ts's
// DEFAULT_INDEXER_SCHEMA — that file can't be imported directly (it pulls
// in `server-only`, which throws outside a Next.js build), so the tiny
// default + sanitize logic is duplicated instead.
//
// Skips (exit 0) when DATABASE_URL is unset, so local builds without a
// database still work. Does not run under `next dev` — it's invoked only
// from the `build` script, never `dev`.
//
// Usage: node scripts/check-indexer-schema.mjs
import postgres from "postgres"

const DEFAULT_INDEXER_SCHEMA = "ponder_v2"
const STALE_THRESHOLD_SEC = 6 * 60 * 60

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.warn(
    "[check-indexer-schema] DATABASE_URL not set, skipping (local build without a DB).",
  )
  process.exit(0)
}

const schema = (process.env.INDEXER_SCHEMA ?? DEFAULT_INDEXER_SCHEMA).replace(
  /[^a-zA-Z0-9_]/g,
  "",
)

const sql = postgres(databaseUrl, {
  ssl: "prefer",
  prepare: false,
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
})

async function fail(message) {
  console.error(`[check-indexer-schema] FAIL: ${message}`)
  await sql.end({ timeout: 1 })
  process.exit(1)
}

async function main() {
  const [{ exists }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}
    ) AS exists
  `
  if (!exists) {
    await fail(
      `schema "${schema}" (INDEXER_SCHEMA) does not exist in this database.`,
    )
    return
  }

  // Same checkpoint decode as lib/indexer-health.ts: 10-digit block
  // timestamp is the first field of Ponder's fixed-width checkpoint string.
  const checkpointRows = await sql.unsafe(
    `SELECT substring(latest_checkpoint, 1, 10)::bigint AS block_ts
     FROM ${schema}._ponder_checkpoint
     ORDER BY latest_checkpoint DESC
     LIMIT 1`,
  ).catch(() => null)

  let latestTs = checkpointRows?.[0]?.block_ts ? Number(checkpointRows[0].block_ts) : null

  if (latestTs === null) {
    // Checkpoint table missing/unexpected shape — fall back to auction activity.
    const rows = await sql.unsafe(
      `SELECT GREATEST(
         (SELECT COALESCE(MAX(created_at_time), 0) FROM ${schema}.pnd_auctions),
         (SELECT COALESCE(MAX(block_time), 0) FROM ${schema}.pnd_bids)
       )::bigint AS block_ts`,
    ).catch(() => null)
    const ts = rows?.[0]?.block_ts ? Number(rows[0].block_ts) : 0
    latestTs = ts > 0 ? ts : null
  }

  if (latestTs === null) {
    await fail(
      `schema "${schema}" exists but has no readable checkpoint or auction activity.`,
    )
    return
  }

  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - latestTs)
  if (ageSeconds > STALE_THRESHOLD_SEC) {
    await fail(
      `schema "${schema}" is stale: last activity ${new Date(latestTs * 1000).toISOString()} (${Math.floor(ageSeconds / 3600)}h ago, threshold is ${STALE_THRESHOLD_SEC / 3600}h).`,
    )
    return
  }

  console.log(
    `[check-indexer-schema] OK: schema "${schema}" last active ${new Date(latestTs * 1000).toISOString()} (${Math.floor(ageSeconds / 60)}m ago).`,
  )
  await sql.end({ timeout: 1 })
  process.exit(0)
}

try {
  await main()
} catch (err) {
  await fail(`could not verify schema "${schema}": ${err.message}`)
}
