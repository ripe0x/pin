/**
 * Detect drift between Ponder's `ponder_sync.factory_addresses` and the
 * application's factory-derived tables. Ponder 0.16 has an occasional
 * realtime-sync bug where new clones land in tables but not in
 * factory_addresses, every per-clone subscription then silently never
 * fires for those clones.
 *
 * Covers every factory-watched child address PND ships: the PND V1, V2 and
 * (once deployed) V2.1 auction house factories, the Surface v1 factory's two child streams
 * (collection address, minter address), and the Surface v2 token and sale
 * CloneFactories (one `Created.instance` stream each). Each stream is
 * matched against `ponder_sync.factories` deterministically (address,
 * childAddressLocation, event selector, chain; then the row that covers the
 * configured INDEXER_SCHEMA's own rows best, see resolveFactoryStream), not
 * by "first row with this address": `ponder_sync` is shared by every
 * indexer build writing to the database.
 *
 * MODES (env `PONDER_DRIFT_REPAIR`):
 *
 *   unset / anything else (default): detect-and-alert. Any child missing
 *   from its watch set, any stream with source rows but no factories row,
 *   and any ambiguous stream fails the iteration (worker_iterations.ok =
 *   false, error names each stream). Nothing is written.
 *
 *   PONDER_DRIFT_REPAIR=1: additionally INSERT the missing rows with the
 *   child's creation block. Only a stopgap: Ponder 0.16 reads child
 *   addresses at startup (the insert takes effect after an indexer
 *   restart) and never refetches intervals it already marked synced, so
 *   the child's past events stay missing until a fresh schema replay. A
 *   failed insert fails the iteration.
 *
 * The durable fix for a decayed watch set is a fresh ponder_vN replay
 * (docs/ponder-schema-cutover.md); scripts/indexer-parity.mjs runs the same
 * comparison read-only before a cutover.
 */
import { toEventSelector } from "viem"
import { sql } from "../db.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"
import type { TaskResult } from "../scheduler.ts"
import {
  MAINNET_CHAIN_ID,
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  SOVEREIGN_AUCTION_HOUSE_V2_1_FACTORY,
  SURFACE_FACTORY,
  SURFACE_TOKEN_FACTORY_V2,
  SALE_FACTORY_V2,
  getAddressOrNull,
} from "@pin/addresses"
import {
  auctionHouseStreams,
  buildFactoryAddressRows,
  factoryCandidates,
  missingAddresses,
  repairEnabled,
  resolveFactoryStream,
  type FactoryRow,
  type FactoryStream,
} from "./ponder-drift-check-lib.ts"

const CHAIN_ID = MAINNET_CHAIN_ID

// Factory events exactly as apps/indexer/ponder.config.ts declares them in
// its factory() bindings. A signature change there changes the selector
// Ponder stores, so keep these in sync.
const AUCTION_HOUSE_CREATED = toEventSelector(
  "event AuctionHouseCreated(address indexed owner, address indexed house, address feeRecipient, uint16 protocolFeeBps)",
)
const SURFACE_CREATED = toEventSelector(
  "event SurfaceCreated(address indexed owner, address indexed collection, address primaryMinter, uint8 idMode, string name, string symbol)",
)
const CLONE_CREATED = toEventSelector(
  "event Created(address indexed implementation, address indexed instance, address indexed caller)",
)

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
  `) as Array<{
    id: number
    factory: {
      address?: string | string[]
      childAddressLocation?: string
      eventSelector?: string
      chainId?: number
      fromBlock?: number
    }
  }>
  return rows
    // An address-array factory is never one of PND's (each is one contract).
    .filter((r) => typeof r.factory.address === "string")
    .map((r) => ({
      id: Number(r.id),
      address: r.factory.address as string,
      childAddressLocation: r.factory.childAddressLocation ?? null,
      eventSelector: r.factory.eventSelector ?? null,
      chainId: r.factory.chainId ?? null,
      fromBlock: r.factory.fromBlock ?? null,
    }))
}

function stream(
  address: string | null,
  childAddressLocation: string,
  eventSelector: string,
): FactoryStream | null {
  return address ? { address, childAddressLocation, eventSelector, chainId: CHAIN_ID } : null
}

type SourceRow = { address: string; blockNumber: string | number }

type StreamOutcome = { missing: number; written: number; problem: string | null }

/** Check (and, in repair mode, repair) one stream's watch set against its source rows. */
async function checkStream(
  factories: FactoryRow[],
  label: string,
  target: FactoryStream | null,
  sourceRows: SourceRow[],
  repair: boolean,
): Promise<StreamOutcome> {
  const ok: StreamOutcome = { missing: 0, written: 0, problem: null }
  if (!target || sourceRows.length === 0) return ok

  const candidates = factoryCandidates(factories, target)
  if (candidates.length === 0) {
    return {
      missing: sourceRows.length,
      written: 0,
      problem:
        `${label}: ${sourceRows.length} ${INDEXER_SCHEMA} rows but no ponder_sync.factories row for ` +
        `${target.address} (${target.childAddressLocation}, ${target.eventSelector})`,
    }
  }

  const ids = candidates.map((c) => c.id)
  const existingRows = (await sql`
    SELECT factory_id, lower(address) AS address FROM ponder_sync.factory_addresses
    WHERE chain_id = ${CHAIN_ID} AND factory_id = ANY(${ids})
  `) as Array<{ factory_id: number; address: string }>
  const existingById = new Map<number, Set<string>>(ids.map((id) => [id, new Set()]))
  for (const r of existingRows) existingById.get(Number(r.factory_id))?.add(r.address)

  const sourceAddresses = sourceRows.map((r) => r.address.toLowerCase())
  const overlapById = new Map(
    ids.map((id) => [id, sourceAddresses.filter((a) => existingById.get(id)!.has(a)).length]),
  )
  const resolution = resolveFactoryStream(candidates, overlapById)
  if (resolution.kind === "ambiguous") {
    return {
      missing: 0,
      written: 0,
      problem: `${label}: ambiguous ponder_sync.factories rows ${resolution.ids.join(",")} (equal overlap); not checked`,
    }
  }
  if (resolution.kind === "none") return ok
  const factoryId = resolution.id

  const missing = missingAddresses(sourceAddresses, existingById.get(factoryId)!)
  if (missing.length === 0) return ok

  const sample = missing.slice(0, 5).join(",")
  const summary =
    `${label}: ${missing.length}/${sourceRows.length} children missing from factory_id=${factoryId} ` +
    `watch set (e.g. ${sample})`
  if (!repair) {
    console.warn(`[ponder-drift] ${summary} (detect-only; set PONDER_DRIFT_REPAIR=1 to insert)`)
    return { missing: missing.length, written: 0, problem: summary }
  }

  const byAddress = new Map(sourceRows.map((r) => [r.address.toLowerCase(), r]))
  const toInsert = buildFactoryAddressRows(
    factoryId,
    CHAIN_ID,
    missing.map((address) => byAddress.get(address)!),
  )
  console.warn(
    `[ponder-drift] ${summary}; inserting. Takes effect on the next indexer restart; ` +
      "past events need a fresh schema replay.",
  )
  let written = 0
  const failures: string[] = []
  for (const row of toInsert) {
    try {
      await sql`
        INSERT INTO ponder_sync.factory_addresses (chain_id, factory_id, address, block_number)
        VALUES (${row.chain_id}, ${row.factory_id}, ${row.address}, ${row.block_number})
        ON CONFLICT DO NOTHING
      `
      written += 1
    } catch (err) {
      console.error(`[ponder-drift] insert ${row.address} (${label}):`, err)
      failures.push(`${row.address}: ${(err as Error).message}`)
    }
  }
  return {
    missing: missing.length,
    written,
    problem: failures.length
      ? `${label}: ${failures.length}/${toInsert.length} repair inserts failed (${failures.slice(0, 3).join("; ")})`
      : null,
  }
}

export async function ponderDriftCheck(): Promise<TaskResult> {
  // Skip if Ponder hasn't created its schema yet (fresh deploy).
  if (!(await tableExists("pnd_houses"))) {
    return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  }

  const repair = repairEnabled(process.env.PONDER_DRIFT_REPAIR)
  const factories = await loadFactories()

  const v1FactoryAddr = getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_FACTORY, CHAIN_ID)
  const v2FactoryAddr = getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_V2_FACTORY, CHAIN_ID)
  const v2_1FactoryAddr = getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_V2_1_FACTORY, CHAIN_ID)
  const surfaceFactoryAddr = getAddressOrNull(SURFACE_FACTORY, CHAIN_ID)
  const tokenFactoryV2Addr = getAddressOrNull(SURFACE_TOKEN_FACTORY_V2, CHAIN_ID)
  const saleFactoryV2Addr = getAddressOrNull(SALE_FACTORY_V2, CHAIN_ID)

  const checks: Array<{ label: string; target: FactoryStream | null; rows: SourceRow[] }> = []

  // pnd_houses.version only exists from the V2 schema onward; on an older
  // schema every house is implicitly V1.
  const hasVersionColumn = await columnExists("pnd_houses", "version")
  const houseRows = (await sql.unsafe(
    hasVersionColumn
      ? `SELECT lower(house) AS address, created_at_block AS block_number, version
         FROM ${INDEXER_SCHEMA}.pnd_houses WHERE created_at_block IS NOT NULL`
      : `SELECT lower(house) AS address, created_at_block AS block_number, 1 AS version
         FROM ${INDEXER_SCHEMA}.pnd_houses WHERE created_at_block IS NOT NULL`,
  )) as Array<{ address: string; block_number: string; version: number }>
  const housesOf = (version: number) =>
    houseRows
      .filter((r) => Number(r.version) === version)
      .map((r) => ({ address: r.address, blockNumber: r.block_number }))
  // One stream per configured factory. V2.1 joins once
  // SOVEREIGN_AUCTION_HOUSE_V2_1_FACTORY is filled (zero until deployed);
  // its houses carry pnd_houses.version 21.
  for (const h of auctionHouseStreams({ v1: v1FactoryAddr, v2: v2FactoryAddr, v2_1: v2_1FactoryAddr })) {
    checks.push({ label: h.label, target: stream(h.factory, "topic2", AUCTION_HOUSE_CREATED), rows: housesOf(h.version) })
  }

  // Surface tables are deploy-gated: absent until the Surface factory has
  // synced its first collection. collections.protocol_version exists from
  // ponder_v4 onward; on an older schema every collection is implicitly v1.
  // Each version's rows are checked only against its own factory's stream
  // (protocol_version = 1 -> SurfaceFactory, 2 -> the v2 CloneFactories): a
  // v2 address in a v1 stream would subscribe it under the v1 ABI.
  if (await tableExists("collections")) {
    const versionExpr = (await columnExists("collections", "protocol_version"))
      ? "c.protocol_version"
      : "1"
    const collectionRows = (await sql.unsafe(
      `SELECT lower(c.collection) AS address, c.created_at_block AS block_number, ${versionExpr} AS version
       FROM ${INDEXER_SCHEMA}.collections c WHERE c.created_at_block IS NOT NULL`,
    )) as Array<{ address: string; block_number: string; version: number }>
    const ofVersion = (rows: typeof collectionRows, version: number) =>
      rows
        .filter((r) => Number(r.version) === version)
        .map((r) => ({ address: r.address, blockNumber: r.block_number }))
    checks.push({ label: "Surface collections", target: stream(surfaceFactoryAddr, "topic2", SURFACE_CREATED), rows: ofVersion(collectionRows, 1) })
    checks.push({ label: "Surface v2 collections", target: stream(tokenFactoryV2Addr, "topic2", CLONE_CREATED), rows: ofVersion(collectionRows, 2) })

    if (await tableExists("minters")) {
      // The collection's creation block is a safe lower bound for its
      // minter or sale: neither can emit before the collection exists.
      const minterRows = (await sql.unsafe(
        `SELECT lower(m.minter) AS address, c.created_at_block AS block_number, ${versionExpr} AS version
         FROM ${INDEXER_SCHEMA}.minters m
         JOIN ${INDEXER_SCHEMA}.collections c ON c.collection = m.collection
         WHERE c.created_at_block IS NOT NULL
           AND lower(m.minter) <> '0x0000000000000000000000000000000000000000'`,
      )) as Array<{ address: string; block_number: string; version: number }>
      // SurfaceCreated's primaryMinter is a non-indexed data field: offset0.
      checks.push({ label: "Surface minters", target: stream(surfaceFactoryAddr, "offset0", SURFACE_CREATED), rows: ofVersion(minterRows, 1) })
      checks.push({ label: "Surface v2 sales", target: stream(saleFactoryV2Addr, "topic2", CLONE_CREATED), rows: ofVersion(minterRows, 2) })
    }
  }

  let missing = 0
  let written = 0
  const problems: string[] = []
  for (const check of checks) {
    // One stream's failure must not hide another's, so collect, then throw.
    const outcome = await checkStream(factories, check.label, check.target, check.rows, repair)
    missing += outcome.missing
    written += outcome.written
    if (outcome.problem) problems.push(outcome.problem)
  }

  if (problems.length > 0) {
    throw new Error(
      `[ponder-drift] ${INDEXER_SCHEMA}: ${problems.join(" | ")}` +
        (repair ? ` (repair mode, ${written} rows written)` : ""),
    )
  }
  return { scopeCount: missing, rpcCalls: 0, rowsWritten: written }
}
