/**
 * Detect drift between Ponder's `ponder_sync.factory_addresses` and the
 * application's factory-derived tables. Ponder 0.16 has an occasional
 * realtime-sync bug where new clones land in tables but not in
 * factory_addresses — every per-clone subscription then silently never
 * fires for those clones.
 *
 * In v2 we have far fewer per-clone subscriptions (PND only). The check
 * stays for that one path. If drift detected, INSERT the missing rows;
 * past events still need a manual reindex (versioned schema upgrade).
 *
 * Logs a structured warning; exit code is informational only.
 */
import { sql } from "../db.ts"
import type { TaskResult } from "../scheduler.ts"

const PND_FACTORY_ID = 1
const CHAIN_ID = 1
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export async function ponderDriftCheck(): Promise<TaskResult> {
  // Skip if Ponder hasn't created its schema yet (fresh deploy).
  const exists = (await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = 'pnd_houses'
    ) AS ready
  `) as Array<{ ready: boolean }>
  if (!exists[0]?.ready) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  // Detect PND houses present in pnd_houses but not in factory_addresses.
  const missing = (await sql.unsafe(
    `SELECT lower(p.house) AS address
     FROM ${INDEXER_SCHEMA}.pnd_houses p
     WHERE NOT EXISTS (
       SELECT 1 FROM ponder_sync.factory_addresses fa
       WHERE fa.chain_id = $1 AND fa.factory_id = $2
         AND lower(fa.address) = lower(p.house)
     )`,
    [CHAIN_ID, PND_FACTORY_ID],
  )) as Array<{ address: string }>

  if (missing.length === 0) {
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }

  console.warn(`[ponder-drift] forwarding ${missing.length} missing PND clones into factory_addresses`)

  for (const { address } of missing) {
    await sql`
      INSERT INTO ponder_sync.factory_addresses (chain_id, factory_id, address)
      VALUES (${CHAIN_ID}, ${PND_FACTORY_ID}, ${address})
      ON CONFLICT DO NOTHING
    `.catch((err) => {
      console.error(`[ponder-drift] insert ${address}:`, err)
    })
  }

  return { scopeCount: missing.length, rpcCalls: 0, rowsWritten: missing.length }
}
