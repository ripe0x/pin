/**
 * For every (artist, FoundationCollection clone) where artist ∈
 * known_artists, scan Transfer-from-zero events on the clone from the
 * worker cursor forward. Upsert into `artist_tokens` and update cursor.
 *
 * Replaces the FoundationCollection per-clone Transfer subscription that
 * v1 carried in Ponder (ponder/src/index.ts:484–503).
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { getFinalizedBoundary } from "../finality.ts"
import { scanArtistTokenTargetsViaTransferFromZero } from "../scanners/transfer-from-zero.ts"
import type { TaskResult } from "../scheduler.ts"

const PLATFORM = "fnd-collection"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g, "",
)

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

  const boundary = await getFinalizedBoundary(client)
  const result = await scanArtistTokenTargetsViaTransferFromZero({
    sql,
    client,
    taskName: "scan-fnd-collections",
    platform: PLATFORM,
    targets: targets.map((target) => ({
      artist: target.artist,
      contract: target.contract,
      contractDeployBlock: BigInt(target.deploy_block),
    })),
    finalizedBlock: boundary.blockNumber,
  })
  return {
    scopeCount: targets.length,
    rpcCalls: boundary.rpcCalls + result.rpcCalls,
    rowsWritten: result.rowsWritten,
  }
}
