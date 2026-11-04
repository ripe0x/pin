/**
 * For every (artist, Mint clone) where artist ∈ known_artists, scan
 * TransferSingle + TransferBatch events with from=0x0 on the clone.
 * Upsert into `artist_tokens` and update cursor.
 *
 * Replaces the MintCollection per-clone subscription
 * (ponder/src/Mint.ts:53–99).
 */
import { sql } from "../db.ts"
import { client, safeHead } from "../rpc.ts"
import { scanErc1155MintsFromZero } from "../scanners/erc1155-mints.ts"
import type { TaskResult } from "../scheduler.ts"
import { loadBackoff, type BackoffPolicy } from "../backoff.ts"
import { describeScanError } from "../scan-range.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"

const PLATFORM = "mint"
const TASK = "scan-mint-clones"
// Interval 10 min: a failing (artist, contract) scope skips ~1 tick, then
// ~3, ~7, ... capped at a day, instead of retrying every tick (backoff.ts).
const BACKOFF: BackoffPolicy = { baseMs: 10 * 60_000, maxMs: 24 * 60 * 60_000 }

export async function scanMintClones(): Promise<TaskResult> {
  const targets = (await sql.unsafe(
    `SELECT lower(c.address)         AS artist,
            lower(c.contract)        AS contract,
            c.first_seen_block::text AS deploy_block
     FROM ${INDEXER_SCHEMA}.mint_creators c
     JOIN known_artists k ON k.address = lower(c.address)`,
  )) as Array<{ artist: string; contract: string; deploy_block: string }>

  // Backfill mint_time for editions scanned before the column existed. Pure
  // Postgres (first mint's block_time from token_1155_mints) — no RPC. Gated on
  // mint_time IS NULL, so it's a no-op once drained.
  await sql`
    UPDATE artist_tokens at
    SET mint_time = sub.min_bt
    FROM (
      SELECT contract, token_id, MIN(block_time) AS min_bt
      FROM token_1155_mints
      GROUP BY contract, token_id
    ) sub
    WHERE at.contract = sub.contract
      AND at.token_id = sub.token_id
      AND at.platform = ${PLATFORM}
      AND at.mint_time IS NULL
      AND sub.min_bt IS NOT NULL
  `

  let totalRpc = 0
  let totalRows = 0

  const backoff = { rows: await loadBackoff(sql, TASK), policy: BACKOFF }
  const errors: string[] = []
  let skipped = 0

  for (const t of targets) {
    const r = await scanErc1155MintsFromZero({
      sql,
      client,
      taskName: TASK,
      safeHead,
      backoff,
      platform: PLATFORM,
      artist: t.artist,
      contract: t.contract,
      contractDeployBlock: BigInt(t.deploy_block),
    }).catch((err) => {
      // Unexpected (DB) failure outside the scan itself.
      console.error(`[scan-mint-clones] ${t.artist}/${t.contract}:`, err)
      return { rpcCalls: 0, rowsWritten: 0, error: (err as Error).message, skipped: false }
    })
    if (r.error) errors.push(describeScanError(`${t.artist}:${t.contract}`, r.error))
    if (r.skipped) skipped++
    totalRpc += r.rpcCalls
    totalRows += r.rowsWritten
  }

  if (skipped > 0) console.warn(`[${TASK}] ${skipped} scope(s) backed off this tick`)
  return { scopeCount: targets.length, rpcCalls: totalRpc, rowsWritten: totalRows, errors }
}
