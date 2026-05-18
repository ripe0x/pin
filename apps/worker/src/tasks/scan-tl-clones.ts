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
import { scanArtistTokensViaTransferFromZero } from "../scanners/transfer-from-zero.ts"
import type { TaskResult } from "../scheduler.ts"

const PLATFORM = "tl"
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
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

  let totalRpc = 0
  let totalRows = 0

  for (const t of targets) {
    const r = await scanArtistTokensViaTransferFromZero({
      sql,
      client,
      taskName: "scan-tl-clones",
      platform: PLATFORM,
      artist: t.artist,
      contract: t.contract,
      contractDeployBlock: BigInt(t.deploy_block),
    }).catch((err) => {
      console.error(`[scan-tl-clones] ${t.artist}/${t.contract}:`, err)
      return { rpcCalls: 0, rowsWritten: 0 }
    })
    totalRpc += r.rpcCalls
    totalRows += r.rowsWritten
  }

  return { scopeCount: targets.length, rpcCalls: totalRpc, rowsWritten: totalRows }
}
