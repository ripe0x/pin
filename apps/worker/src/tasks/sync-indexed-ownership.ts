/**
 * Mirror Ponder's bounded ERC-721 current-state streams into the canonical
 * public ownership model. This is Postgres-to-Postgres work: zero RPC, no
 * per-token polling, and no request-path fallback.
 */
import { sql } from "../db.ts"
import {
  recordErc721Ownership,
  type OwnershipCoverage,
} from "../ownership-store.ts"
import type { TaskResult } from "../scheduler.ts"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)
const BATCH_SIZE = 2_000
const COVERAGE = new Set<OwnershipCoverage>([
  "complete",
  "partial",
  "snapshot",
  "stale",
])

type IndexedOwnershipRow = {
  contract: string
  token_id: string
  owner: string
  source: string
  coverage_status: string
  last_block: string
  log_index: string
  block_time: string
  tx_hash: string
}

async function sourceTableExists(): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = ${INDEXER_SCHEMA}
      AND table_name = 'token_ownership'
    LIMIT 1
  `) as Array<{ "?column?": number }>
  return rows.length > 0
}

export async function syncIndexedOwnership(): Promise<TaskResult> {
  if (!(await sourceTableExists())) {
    throw new Error(`${INDEXER_SCHEMA}.token_ownership is missing`)
  }

  const rows = (await sql.unsafe(
    `SELECT
       lower(p.contract) AS contract,
       p.token_id::text AS token_id,
       lower(p.owner) AS owner,
       p.source,
       p.coverage_status,
       p.last_block::text AS last_block,
       p.log_index::text AS log_index,
       p.block_time::text AS block_time,
       p.tx_hash
     FROM ${INDEXER_SCHEMA}.token_ownership p
     LEFT JOIN public.token_ownership c
       ON c.contract = lower(p.contract)
      AND c.token_id = p.token_id::text
     WHERE c.contract IS NULL
        OR (c.last_block, c.log_index) < (p.last_block, p.log_index)
        OR (
          c.source = p.source AND (
            c.owner IS DISTINCT FROM lower(p.owner)
            OR c.last_block IS DISTINCT FROM p.last_block
            OR c.log_index IS DISTINCT FROM p.log_index
            OR c.tx_hash IS DISTINCT FROM p.tx_hash
          )
        )
     ORDER BY p.last_block, p.log_index, p.contract, p.token_id
     LIMIT ${BATCH_SIZE}`,
  )) as IndexedOwnershipRow[]

  let rowsWritten = 0
  for (const row of rows) {
    if (!COVERAGE.has(row.coverage_status as OwnershipCoverage)) {
      throw new Error(
        `Unknown ownership coverage status ${row.coverage_status} from ${row.source}`,
      )
    }
    await recordErc721Ownership(
      sql,
      {
        contract: row.contract,
        tokenId: row.token_id,
        owner: row.owner,
        source: row.source,
        blockNumber: BigInt(row.last_block),
        logIndex: BigInt(row.log_index),
        txHash: row.tx_hash,
        blockTime: BigInt(row.block_time),
        // Ponder's current-state table is reorg-aware but follows head. A
        // finalized boundary supplied by #295 can promote these rows later.
        finalized: false,
        coverageStatus: row.coverage_status as OwnershipCoverage,
      },
      true,
    )
    rowsWritten += 1
  }

  return { scopeCount: rows.length, rpcCalls: 0, rowsWritten }
}
