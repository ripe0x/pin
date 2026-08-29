/**
 * For every (artist, Mint clone) where artist ∈ known_artists, scan
 * TransferSingle + TransferBatch events with from=0x0 on the clone.
 * Upsert into `artist_tokens` and update cursor.
 *
 * Replaces the MintCollection per-clone subscription
 * (ponder/src/Mint.ts:53–99).
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { getFinalizedBoundary } from "../finality.ts"
import { scanErc1155TargetsFromZero } from "../scanners/erc1155-mints.ts"
import type { TaskResult } from "../scheduler.ts"

const PLATFORM = "mint"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g, "",
)

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

  const boundary = await getFinalizedBoundary(client)
  const result = await scanErc1155TargetsFromZero({
    sql,
    client,
    taskName: "scan-mint-clones",
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
