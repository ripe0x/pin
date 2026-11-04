/**
 * For every (artist, FoundationCollection clone) where artist ∈
 * known_artists, scan Transfer-from-zero events on the clone from the
 * worker cursor forward. Upsert into `artist_tokens` and update cursor.
 *
 * Replaces the FoundationCollection per-clone Transfer subscription that
 * v1 carried in Ponder (ponder/src/index.ts:484–503).
 */
import { sql } from "../db.ts"
import { client, safeHead } from "../rpc.ts"
import { scanArtistTokensViaTransferFromZero } from "../scanners/transfer-from-zero.ts"
import type { TaskResult } from "../scheduler.ts"
import { loadBackoff, type BackoffPolicy } from "../backoff.ts"
import { describeScanError } from "../scan-range.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"

const PLATFORM = "fnd-collection"
const TASK = "scan-fnd-collections"
// Interval 10 min: a failing (artist, contract) scope skips ~1 tick, then
// ~3, ~7, ... capped at a day, instead of retrying every tick (backoff.ts).
const BACKOFF: BackoffPolicy = { baseMs: 10 * 60_000, maxMs: 24 * 60 * 60_000 }

export async function scanFndCollections(): Promise<TaskResult> {
  // Each row = one (artist, contract) pair to scan. Two discovery
  // sources: Ponder's live factory subscription (post-FND_START_BLOCK
  // deploys) and the frozen full-history seed (migration 023) for the
  // ~thousands of collections deployed before the indexer window —
  // without the seed, an artist admitted via artist_seeds whose
  // collection predates ~Oct 2025 would never get scanned.
  const targets = (await sql.unsafe(
    `SELECT lower(c.creator)    AS artist,
            lower(c.collection) AS contract,
            c.created_at_block::text AS deploy_block
     FROM ${INDEXER_SCHEMA}.fnd_collections c
     JOIN known_artists k ON k.address = lower(c.creator)
     UNION
     SELECT s.creator AS artist,
            s.collection AS contract,
            s.deploy_block::text AS deploy_block
     FROM fnd_collections_seed s
     JOIN known_artists k ON k.address = s.creator`,
  )) as Array<{ artist: string; contract: string; deploy_block: string }>

  let totalScope = 0
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
      console.error(`[scan-fnd-collections] ${t.artist}/${t.contract}:`, err)
      return { rpcCalls: 0, rowsWritten: 0, error: (err as Error).message, skipped: false }
    })
    if (r.error) errors.push(describeScanError(`${t.artist}:${t.contract}`, r.error))
    if (r.skipped) skipped++
    totalScope++
    totalRpc += r.rpcCalls
    totalRows += r.rowsWritten
  }

  if (skipped > 0) console.warn(`[${TASK}] ${skipped} scope(s) backed off this tick`)
  return { scopeCount: totalScope, rpcCalls: totalRpc, rowsWritten: totalRows, errors }
}
