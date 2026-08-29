/**
 * Detect drift between Ponder's `ponder_sync.factory_addresses` and the
 * application's factory-derived tables. Missing children mean their
 * per-clone events were never indexed, so this is a hard integrity failure.
 *
 * Never mutate Ponder's internal tables here. Their row shape and invariants
 * are Ponder-owned, and forwarding a child cannot recover already-missed
 * history. Recovery is a fresh versioned-schema backfill and guarded cutover.
 */
import { sql } from "../db.ts"
import type { TaskResult } from "../scheduler.ts"

const CHAIN_ID = 1
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export async function ponderDriftCheck(): Promise<TaskResult> {
  const exists = (await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = 'pnd_houses'
    ) AS ready
  `) as Array<{ ready: boolean }>
  if (!exists[0]?.ready) {
    throw new Error(`[ponder-drift] ${INDEXER_SCHEMA}.pnd_houses is missing`)
  }

  const houseCountRows = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${INDEXER_SCHEMA}.pnd_houses`,
  )) as Array<{ n: number }>
  const houseCount = houseCountRows[0]?.n ?? 0
  if (houseCount === 0) {
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }

  // Factory ids are Ponder internals, not stable application constants.
  // Resolve the live id by address overlap with the public pnd_houses table.
  const factoryRows = (await sql.unsafe(
    `SELECT fa.factory_id::int AS factory_id, count(*)::int AS matches
       FROM ponder_sync.factory_addresses fa
       JOIN ${INDEXER_SCHEMA}.pnd_houses p
         ON lower(p.house) = lower(fa.address)
      WHERE fa.chain_id = $1
      GROUP BY fa.factory_id
      ORDER BY matches DESC, fa.factory_id
      LIMIT 1`,
    [CHAIN_ID],
  )) as Array<{ factory_id: number; matches: number }>
  const factoryId = factoryRows[0]?.factory_id
  if (factoryId === undefined) {
    throw new Error(
      `[ponder-drift] no factory_addresses overlap for ${houseCount} PND houses`,
    )
  }

  const missingSync = (await sql.unsafe(
    `SELECT lower(p.house) AS address
     FROM ${INDEXER_SCHEMA}.pnd_houses p
     WHERE NOT EXISTS (
       SELECT 1 FROM ponder_sync.factory_addresses fa
       WHERE fa.chain_id = $1 AND fa.factory_id = $2
         AND lower(fa.address) = lower(p.house)
     )`,
    [CHAIN_ID, factoryId],
  )) as Array<{ address: string }>

  const missingHouses = (await sql.unsafe(
    `SELECT lower(fa.address) AS address
       FROM ponder_sync.factory_addresses fa
      WHERE fa.chain_id = $1 AND fa.factory_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM ${INDEXER_SCHEMA}.pnd_houses p
           WHERE lower(p.house) = lower(fa.address)
        )`,
    [CHAIN_ID, factoryId],
  )) as Array<{ address: string }>

  if (missingSync.length > 0 || missingHouses.length > 0) {
    throw new Error(
      `[ponder-drift] PND factory drift (factory_id=${factoryId}, ` +
        `houses_missing_from_sync=${missingSync.length}/${houseCount}, ` +
        `sync_children_missing_from_houses=${missingHouses.length}); ` +
        `fresh Ponder backfill required`,
    )
  }

  return { scopeCount: houseCount, rpcCalls: 0, rowsWritten: 0 }
}
