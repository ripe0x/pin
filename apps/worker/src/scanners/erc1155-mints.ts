/**
 * Generic incremental ERC-1155 mint scanner. Watches TransferSingle and
 * TransferBatch events on a specific clone, filtered to from=0x0.
 *
 * Used by Mint protocol clones. Each clone's tokens go into
 * `artist_tokens` with platform='mint'.
 *
 * Edition handling: ERC-1155 editions share a tokenId on the same
 * contract. We collapse via `ON CONFLICT (contract, token_id) DO
 * NOTHING` — the first mint wins, subsequent edition mints are silently
 * deduped.
 */
import type { Sql } from "postgres"
import {
  parseAbiItem, getAddress, type Address, type PublicClient,
} from "viem"
import { resolveNewTokenOwner } from "./resolve-owner.ts"
import { throttleRpc } from "../throttle.ts"

const TRANSFER_SINGLE = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
)
const TRANSFER_BATCH = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
)
const ZERO = "0x0000000000000000000000000000000000000000"
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin. Per-tick iteration count kept low so each cycle leaves
// budget for other tasks; backfill spread across many cycles is fine.
const MAX_BLOCKS_PER_SCAN = 9_500n
const MAX_ITERATIONS_PER_CALL = 15

export type Erc1155ScanArgs = {
  sql: Sql
  client: PublicClient
  taskName: string
  platform: string
  artist: string
  contract: string
  contractDeployBlock: bigint
}

export type Erc1155ScanResult = {
  rpcCalls: number
  rowsWritten: number
}

export async function scanErc1155MintsFromZero(
  args: Erc1155ScanArgs,
): Promise<Erc1155ScanResult> {
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
  let cursor = cursorRow[0] ? BigInt(cursorRow[0].last_block) + 1n : contractDeployBlock

  let iterations = 0
  while (cursor <= head && iterations < MAX_ITERATIONS_PER_CALL) {
    const toBlock = cursor + MAX_BLOCKS_PER_SCAN > head
      ? head
      : cursor + MAX_BLOCKS_PER_SCAN

    // Resolve block timestamps once per distinct block, so mint-history rows
    // carry real dates. Deduped + throttled; bounded by the number of distinct
    // mint blocks in the window (small — editions mint rarely).
    const blockTime = new Map<bigint, bigint>()
    const blockTimeFor = async (bn: bigint): Promise<bigint> => {
      const cached = blockTime.get(bn)
      if (cached !== undefined) return cached
      await throttleRpc()
      const blk = await client.getBlock({ blockNumber: bn })
      rpcCalls += 1
      blockTime.set(bn, blk.timestamp)
      return blk.timestamp
    }

    // TransferSingle batch
    await throttleRpc()
    const singles = await client.getLogs({
      address: getAddress(contract) as Address,
      event: TRANSFER_SINGLE,
      args: { from: ZERO as `0x${string}` },
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1

    for (const log of singles) {
      if (log.args.id === undefined) continue
      const tokenId = log.args.id.toString()
      await sql`
        INSERT INTO artist_tokens
          (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
        VALUES
          (${artist}, ${contract}, ${tokenId}, ${platform},
           ${log.blockNumber!.toString()}::bigint, ${log.logIndex!}, NOW())
        ON CONFLICT (contract, token_id) DO NOTHING
      `
      rowsWritten += 1
      // Mint-history row. ERC-1155 editions mint the same tokenId multiple
      // times, so this is one row per mint event (PK includes log_index), not
      // deduped by tokenId — that's what drives edition supply (Σ amount) and
      // the mint timeline. value is the number of copies minted.
      const ts = await blockTimeFor(log.blockNumber!)
      await sql`
        INSERT INTO token_1155_mints
          (contract, token_id, to_addr, amount, block_number, block_time, tx_hash, log_index)
        VALUES
          (${contract}, ${tokenId}, ${(log.args.to as string).toLowerCase()},
           ${(log.args.value as bigint).toString()}, ${log.blockNumber!.toString()}::bigint,
           ${ts.toString()}::bigint, ${log.transactionHash!}, ${log.logIndex!})
        ON CONFLICT (tx_hash, log_index, token_id) DO NOTHING
      `
      await resolveNewTokenOwner({ sql, client, contract, tokenId })
      rpcCalls += 1
    }

    // TransferBatch
    await throttleRpc()
    const batches = await client.getLogs({
      address: getAddress(contract) as Address,
      event: TRANSFER_BATCH,
      args: { from: ZERO as `0x${string}` },
      fromBlock: cursor,
      toBlock,
    })
    rpcCalls += 1

    for (const log of batches) {
      const ids = (log.args.ids ?? []) as readonly bigint[]
      const values = (log.args.values ?? []) as readonly bigint[]
      const ts = ids.length > 0 ? await blockTimeFor(log.blockNumber!) : 0n
      for (let i = 0; i < ids.length; i++) {
        const tokenId = ids[i].toString()
        await sql`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
          VALUES
            (${artist}, ${contract}, ${tokenId}, ${platform},
             ${log.blockNumber!.toString()}::bigint, ${log.logIndex!}, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
        `
        rowsWritten += 1
        // One mint-history row per id in the batch. ids[i] ↔ values[i].
        await sql`
          INSERT INTO token_1155_mints
            (contract, token_id, to_addr, amount, block_number, block_time, tx_hash, log_index)
          VALUES
            (${contract}, ${tokenId}, ${(log.args.to as string).toLowerCase()},
             ${(values[i] ?? 0n).toString()}, ${log.blockNumber!.toString()}::bigint,
             ${ts.toString()}::bigint, ${log.transactionHash!}, ${log.logIndex!})
          ON CONFLICT (tx_hash, log_index, token_id) DO NOTHING
        `
      }
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
