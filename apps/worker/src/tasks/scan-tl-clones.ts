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
import { client } from "../rpc.ts"
import { getFinalizedBoundary } from "../finality.ts"
import { scanArtistTokenTargetsViaTransferFromZero } from "../scanners/transfer-from-zero.ts"
import type { TaskResult } from "../scheduler.ts"

const PLATFORM = "tl"
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g, "",
)

export async function scanTlClones(): Promise<TaskResult> {
  const targets = (await sql.unsafe(
    `SELECT lower(c.sender)          AS artist,
            lower(c.contract)        AS contract,
            c.first_seen_block::text AS deploy_block
     FROM ${INDEXER_SCHEMA}.tl_creators c
     JOIN known_artists k ON k.address = lower(c.sender)
     WHERE c.c_type LIKE 'ERC721%'`,
  )) as Array<{ artist: string; contract: string; deploy_block: string }>

  const boundary = await getFinalizedBoundary(client)
  const result = await scanArtistTokenTargetsViaTransferFromZero({
    sql,
    client,
    taskName: "scan-tl-clones",
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
