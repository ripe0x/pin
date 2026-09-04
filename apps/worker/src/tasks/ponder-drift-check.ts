/**
 * Detect drift between Ponder's `ponder_sync.factory_addresses` and the
 * application's factory-derived tables. Ponder 0.16 has an occasional
 * realtime-sync bug where new clones land in tables but not in
 * factory_addresses, every per-clone subscription then silently never
 * fires for those clones.
 *
 * Covers every factory-watched child address PND ships: the PND V1 and V2
 * auction house factories, and the Surface factory's two child streams
 * (collection address, minter address). Factory ids in
 * `ponder_sync.factories` are assigned by Ponder at sync time and are not
 * stable across a fresh replay, so ids are resolved at runtime by matching
 * the factory contract address (and, for Surface, the childAddressLocation
 * that distinguishes the collection stream from the minter stream) rather
 * than hardcoded.
 *
 * If drift is detected, INSERT the missing rows with the child's actual
 * creation block; past events still need a manual reindex.
 *
 * Logs a structured warning per factory; exit code is informational only.
 */
import { sql } from "../db.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"
import type { TaskResult } from "../scheduler.ts"
import {
  MAINNET_CHAIN_ID,
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  SURFACE_FACTORY,
  getAddressOrNull,
} from "@pin/addresses"
import {
  buildFactoryAddressRows,
  missingAddresses,
  resolveFactoryId,
  type FactoryRow,
} from "./ponder-drift-check-lib.ts"

const CHAIN_ID = MAINNET_CHAIN_ID

async function tableExists(table: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = ${table}
    ) AS ready
  `) as Array<{ ready: boolean }>
  return rows[0]?.ready === true
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = ${table} AND column_name = ${column}
    ) AS present
  `) as Array<{ present: boolean }>
  return rows[0]?.present === true
}

async function loadFactories(): Promise<FactoryRow[]> {
  const rows = (await sql`
    SELECT id, factory FROM ponder_sync.factories
  `) as Array<{ id: number; factory: { address: string; childAddressLocation?: string } }>
  return rows.map((r) => ({
    id: r.id,
    address: r.factory.address,
    childAddressLocation: r.factory.childAddressLocation ?? null,
  }))
}

/** Repair one factory's watch set against one set of source rows. Returns rows written. */
async function repairFactory(
  factoryId: number | undefined,
  label: string,
  sourceRows: Array<{ address: string; blockNumber: string | number }>,
): Promise<number> {
  if (factoryId === undefined || sourceRows.length === 0) return 0

  const existing = (await sql`
    SELECT lower(address) AS address FROM ponder_sync.factory_addresses
    WHERE chain_id = ${CHAIN_ID} AND factory_id = ${factoryId}
  `) as Array<{ address: string }>

  const missing = missingAddresses(
    sourceRows.map((r) => r.address),
    existing.map((e) => e.address),
  )
  if (missing.length === 0) return 0

  const byAddress = new Map(sourceRows.map((r) => [r.address.toLowerCase(), r]))
  const toInsert = buildFactoryAddressRows(
    factoryId,
    CHAIN_ID,
    missing.map((address) => byAddress.get(address)!),
  )

  console.warn(
    `[ponder-drift] forwarding ${toInsert.length} missing ${label} into factory_addresses (factory_id=${factoryId})`,
  )

  let written = 0
  for (const row of toInsert) {
    await sql`
      INSERT INTO ponder_sync.factory_addresses (chain_id, factory_id, address, block_number)
      VALUES (${row.chain_id}, ${row.factory_id}, ${row.address}, ${row.block_number})
      ON CONFLICT DO NOTHING
    `
      .then(() => { written += 1 })
      .catch((err) => {
        console.error(`[ponder-drift] insert ${row.address} (${label}):`, err)
      })
  }
  return written
}

export async function ponderDriftCheck(): Promise<TaskResult> {
  // Skip if Ponder hasn't created its schema yet (fresh deploy).
  if (!(await tableExists("pnd_houses"))) {
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }

  const factories = await loadFactories()

  const v1FactoryAddr = getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_FACTORY, CHAIN_ID)
  const v2FactoryAddr = getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_V2_FACTORY, CHAIN_ID)
  const surfaceFactoryAddr = getAddressOrNull(SURFACE_FACTORY, CHAIN_ID)

  const v1Id = v1FactoryAddr ? resolveFactoryId(factories, v1FactoryAddr) : undefined
  const v2Id = v2FactoryAddr ? resolveFactoryId(factories, v2FactoryAddr) : undefined
  // Surface's factory emits two child streams off the same creation log:
  // topic2 carries the collection address, offset0 carries the minter
  // address (zero when the collection has no separate minter).
  const surfaceCollectionId = surfaceFactoryAddr
    ? resolveFactoryId(factories, surfaceFactoryAddr, "topic2")
    : undefined
  const surfaceMinterId = surfaceFactoryAddr
    ? resolveFactoryId(factories, surfaceFactoryAddr, "offset0")
    : undefined

  let rowsWritten = 0

  // pnd_houses.version only exists from the V2 schema onward; on an older
  // schema every house is implicitly V1.
  const hasVersionColumn = await columnExists("pnd_houses", "version")
  const houseRows = (await sql.unsafe(
    hasVersionColumn
      ? `SELECT lower(house) AS address, created_at_block AS block_number, version
         FROM ${INDEXER_SCHEMA}.pnd_houses`
      : `SELECT lower(house) AS address, created_at_block AS block_number, 1 AS version
         FROM ${INDEXER_SCHEMA}.pnd_houses`,
  )) as Array<{ address: string; block_number: string; version: number }>

  rowsWritten += await repairFactory(
    v1Id,
    "PND V1 houses",
    houseRows.filter((r) => r.version === 1).map((r) => ({ address: r.address, blockNumber: r.block_number })),
  )
  rowsWritten += await repairFactory(
    v2Id,
    "PND V2 houses",
    houseRows.filter((r) => r.version === 2).map((r) => ({ address: r.address, blockNumber: r.block_number })),
  )

  // Surface tables are deploy-gated: absent until the Surface factory has
  // synced its first collection.
  if (await tableExists("collections")) {
    const collectionRows = (await sql.unsafe(
      `SELECT lower(collection) AS address, created_at_block AS block_number
       FROM ${INDEXER_SCHEMA}.collections`,
    )) as Array<{ address: string; block_number: string }>
    rowsWritten += await repairFactory(
      surfaceCollectionId,
      "Surface collections",
      collectionRows.map((r) => ({ address: r.address, blockNumber: r.block_number })),
    )

    if (await tableExists("minters")) {
      const minterRows = (await sql.unsafe(
        `SELECT lower(m.minter) AS address, c.created_at_block AS block_number
         FROM ${INDEXER_SCHEMA}.minters m
         JOIN ${INDEXER_SCHEMA}.collections c ON c.collection = m.collection`,
      )) as Array<{ address: string; block_number: string }>
      rowsWritten += await repairFactory(
        surfaceMinterId,
        "Surface minters",
        minterRows.map((r) => ({ address: r.address, blockNumber: r.block_number })),
      )
    }
  }

  return { scopeCount: rowsWritten, rpcCalls: 0, rowsWritten }
}
