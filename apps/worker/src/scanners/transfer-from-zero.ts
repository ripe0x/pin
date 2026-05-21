/**
 * Generic incremental ERC-721 Transfer-from-zero scanner. Used by
 * FND-collection, TL-clone, and (potentially future) per-artist
 * contracts that share the "Transfer with from=0x0 is a mint" pattern.
 *
 * For each (task, contract) pair, the cursor in `worker_cursors` tracks
 * the last-scanned block. First scan covers `contractDeployBlock → head`
 * in chunks of MAX_BLOCKS_PER_SCAN. Subsequent scans cover
 * `cursor+1 → head`.
 *
 * Discovered mints upsert into `artist_tokens`. The companion
 * `resolveNewTokenOwner` helper writes an immediate `token_owners` row
 * so /collector/[address] never sees a null-owner window.
 */
import type { Sql } from "postgres"
import {
  parseAbiItem, getAddress, type Address, type PublicClient,
} from "viem"
import { resolveNewTokenOwner } from "./resolve-owner.ts"
import { throttleRpc } from "../throttle.ts"

const TRANSFER_FROM_ZERO = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const ZERO = "0x0000000000000000000000000000000000000000"
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin. Per-tick iteration count kept low so each cycle leaves
// budget for other tasks; backfill spread across many cycles is fine.
const MAX_BLOCKS_PER_SCAN = 9_500n
const MAX_ITERATIONS_PER_CALL = 15

export type ScanArgs = {
  // postgres.js Sql instance — typed loosely because the library's
  // generic surface is heavy and we only use template-tag + unsafe.
  sql: Sql
  client: PublicClient
  taskName: string
  platform: string
  artist: string
  contract: string
  contractDeployBlock: bigint
}

export type ScanResult = {
  rpcCalls: number
  rowsWritten: number
}

export async function scanArtistTokensViaTransferFromZero(
  args: ScanArgs,
): Promise<ScanResult> {
  const { sql, client, taskName, platform, artist, contract, contractDeployBlock } = args

  const scope = `${artist}:${contract}`
  const head = await client.getBlockNumber()
  let rpcCalls = 1
  let rowsWritten = 0

  const cursorRow = (await sql`
    SELECT last_block::text AS last_block
    FROM worker_cursors WHERE task = ${taskName} AND scope = ${scope}
    LIMIT 1
  `) as Array<{ last_block: string }>

  let cursor = cursorRow[0]
    ? BigInt(cursorRow[0].last_block) + 1n
    : contractDeployBlock

  let iterations = 0
  while (cursor <= head && iterations < MAX_ITERATIONS_PER_CALL) {
    const toBlock = cursor + MAX_BLOCKS_PER_SCAN > head
      ? head
      : cursor + MAX_BLOCKS_PER_SCAN

    await throttleRpc()
    const logs = await client.getLogs({
      address: getAddress(contract) as Address,
      event: TRANSFER_FROM_ZERO,
      args: { from: ZERO as `0x${string}`, to: getAddress(artist) as Address },
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1

    for (const log of logs) {
      if (!log.args.tokenId) continue
      const tokenId = log.args.tokenId.toString()

      await sql`
        INSERT INTO artist_tokens
          (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
        VALUES
          (${artist}, ${contract}, ${tokenId}, ${platform},
           ${log.blockNumber!.toString()}::bigint, ${log.logIndex!}, NOW())
        ON CONFLICT (contract, token_id) DO NOTHING
      `
      rowsWritten += 1

      // Event-triggered single ownerOf — populates token_owners
      // immediately so /collector/[address] never sees a null window.
      await resolveNewTokenOwner({ sql, client, contract, tokenId })
      rpcCalls += 1
    }

    cursor = toBlock + 1n
    await sql`
      INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
      VALUES (${taskName}, ${scope}, ${toBlock.toString()}::bigint, NOW())
      ON CONFLICT (task, scope) DO UPDATE SET
        last_block = EXCLUDED.last_block, last_run_at = NOW()
    `
    iterations++
  }

  return { rpcCalls, rowsWritten }
}
