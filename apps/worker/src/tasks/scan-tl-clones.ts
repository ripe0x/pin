/**
 * For every (artist, TL ERC-721 clone) where artist ∈ known_artists,
 * scan Transfer-from-zero events on the clone. Upsert into
 * `artist_tokens` and update cursor.
 *
 * ERC-1155 TL clones are intentionally out of scope — matches v1 deferral.
 * The filter `cType LIKE 'ERC721%'` happens at the SQL layer.
 *
 * Replaces the TLCollection per-clone subscription
 * (ponder/src/TL.ts:69–94).
 */
import { sql } from "../db.ts"
import { client, safeHead } from "../rpc.ts"
import { scanArtistTokensViaTransferFromZero } from "../scanners/transfer-from-zero.ts"
import type { TaskResult } from "../scheduler.ts"
import { loadBackoff, type BackoffPolicy } from "../backoff.ts"
import { describeScanError } from "../scan-range.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"

const PLATFORM = "tl"
const TASK = "scan-tl-clones"
// Interval 10 min: a failing (artist, contract) scope skips ~1 tick, then
// ~3, ~7, ... capped at a day, instead of retrying every tick (backoff.ts).
const BACKOFF: BackoffPolicy = { baseMs: 10 * 60_000, maxMs: 24 * 60 * 60_000 }

export async function scanTlClones(): Promise<TaskResult> {
  const targets = (await sql.unsafe(
    `SELECT lower(c.sender)          AS artist,
            lower(c.contract)        AS contract,
            c.first_seen_block::text AS deploy_block
     FROM ${INDEXER_SCHEMA}.tl_creators c
     JOIN known_artists k ON k.address = lower(c.sender)
     WHERE c.c_type LIKE 'ERC721%'`,
  )) as Array<{ artist: string; contract: string; deploy_block: string }>

  let totalRpc = 0
  let totalRows = 0

  const backoff = { rows: await loadBackoff(sql, TASK), policy: BACKOFF }
  const errors: string[] = []
  let skipped = 0

  for (const t of targets) {
    const r = await scanArtistTokensViaTransferFromZero({
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
      console.error(`[scan-tl-clones] ${t.artist}/${t.contract}:`, err)
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
