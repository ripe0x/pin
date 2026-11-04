import "server-only"
import { sql } from "./db"
import { INDEXER_SCHEMA } from "./indexer-schema"
import { withTimeout } from "./indexer-queries"

const INDEXER_DISABLED = process.env.INDEXER_DISABLED === "1"

// The MURI tables ship with the MURI indexer release; probe before reading
// so a schema without them hides the fact instead of erroring the page.
// Sticky once true; a failed probe reads as absent and retries next call.
let muriTablesSeen = false
async function muriTablesExist(db: NonNullable<typeof sql>, schema: string): Promise<boolean> {
  if (muriTablesSeen) return true
  try {
    const rows = (await db.unsafe(
      `SELECT (to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL) AS ok`,
      [`${schema}.muri_contracts`, `${schema}.muri_tokens`],
    )) as Array<{ ok: boolean }>
    if (rows[0]?.ok) muriTablesSeen = true
    return muriTablesSeen
  } catch {
    return false
  }
}

/**
 * What the indexed MURI data says about one collection: whether the
 * contract is registered with MURI and how many of its tokens carry a MURI
 * record. Two COUNT/EXISTS SELECTs, zero chain reads. Null when the indexer
 * is unavailable or the tables are missing; the Preservation card then
 * leaves the MURI line out. Shown for v1 only (lib/preservation.ts).
 */
export async function getMuriCollectionAnchor(
  contract: string,
): Promise<{ registered: boolean; tokens: number } | null> {
  if (INDEXER_DISABLED || !sql) return null
  const db = sql
  const schema = INDEXER_SCHEMA
  if (!(await muriTablesExist(db, schema))) return null
  return withTimeout(async () => {
    const rows = (await db.unsafe(
      `SELECT EXISTS (SELECT 1 FROM ${schema}.muri_contracts WHERE lower(contract) = $1) AS registered,
              (SELECT COUNT(*)::int FROM ${schema}.muri_tokens WHERE lower(contract) = $1) AS tokens`,
      [contract.toLowerCase()],
    )) as Array<{ registered: boolean; tokens: number }>
    const r = rows[0]
    return r ? { registered: r.registered, tokens: Number(r.tokens) } : null
  })
}
