import { sql } from "./db.ts"

export const INDEXER_SCHEMA = (
  process.env.INDEXER_SCHEMA ?? "indexer_live"
).replace(/[^a-zA-Z0-9_]/g, "")

export async function validateIndexerBinding(): Promise<void> {
  if (
    INDEXER_SCHEMA !== "indexer_live" &&
    process.env.ALLOW_VERSIONED_INDEXER_SCHEMA !== "1"
  ) {
    throw new Error(
      `INDEXER_SCHEMA=${INDEXER_SCHEMA} bypasses the stable alias; ` +
        "set ALLOW_VERSIONED_INDEXER_SCHEMA=1 only for recovery",
    )
  }

  const state = (await sql`
    SELECT active_schema, build_id
    FROM public.indexer_state
    WHERE singleton = TRUE
    LIMIT 1
  `) as Array<{ active_schema: string | null; build_id: string | null }>
  if (!state[0]?.active_schema || !state[0].build_id) {
    throw new Error("indexer_state has no active cutover")
  }

  const meta = (await sql.unsafe(
    `SELECT value FROM ${INDEXER_SCHEMA}._ponder_meta WHERE key = 'app' LIMIT 1`,
  )) as Array<{ value: { build_id?: string; is_ready?: number | boolean } }>
  const app = meta[0]?.value
  if (!app || (app.is_ready !== 1 && app.is_ready !== true)) {
    throw new Error(`${INDEXER_SCHEMA} is not ready`)
  }
  if (app.build_id !== state[0].build_id) {
    throw new Error(
      `${INDEXER_SCHEMA} build ${app.build_id ?? "missing"} disagrees with ` +
        `indexer_state ${state[0].build_id}`,
    )
  }
}
