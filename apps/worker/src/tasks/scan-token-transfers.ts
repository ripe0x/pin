/**
 * For every contract in `artist_tokens`, scan ERC-721 Transfer events
 * from `worker_cursors.last_block` forward. Upsert ownership into
 * `token_owners`; append history rows to `token_transfers`.
 *
 * Critical optimization: for the first-time backfill of a contract,
 * cursor starts at MIN(mint_block) FROM artist_tokens WHERE contract=$1
 * — bounds the scan to "transfers of tokens we actually care about,"
 * not the contract's full deploy-to-head range. Foundation NFT shared
 * contract has ~5 years of transfers; this optimization is what makes
 * the first scan tractable.
 *
 * The web app reads token_owners directly. After this task has caught
 * up, every /collector/[address] inverse query is a Postgres point
 * lookup with zero external API calls.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { parseAbiItem, getAddress, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin.
const MAX_BLOCKS_PER_SCAN = 9_500n
// Per-task wall-time cap: process up to N chunks per contract per task
// invocation, then let the next interval pick up where we left off. With
// 9_500 block chunks and the task running every 5 min, 50 chunks per
// call = ~475K blocks/cycle, so a year of history backfills in ~5 cycles.
const MAX_CHUNKS_PER_CONTRACT = 50n
const TASK = "scan-token-transfers"

async function getContracts(): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT lower(contract) AS contract FROM artist_tokens
  `) as Array<{ contract: string }>
  return rows.map((r) => r.contract)
}

async function getCursor(contract: string): Promise<bigint | null> {
  const rows = (await sql`
    SELECT last_block::text AS last_block
    FROM worker_cursors
    WHERE task = ${TASK} AND scope = ${contract}
    LIMIT 1
  `) as Array<{ last_block: string }>
  return rows[0] ? BigInt(rows[0].last_block) : null
}

async function getEarliestMintBlock(contract: string): Promise<bigint> {
  const rows = (await sql`
    SELECT MIN(mint_block)::text AS min_block
    FROM artist_tokens
    WHERE lower(contract) = ${contract}
  `) as Array<{ min_block: string | null }>
  return rows[0]?.min_block ? BigInt(rows[0].min_block) : 0n
}

async function setCursor(contract: string, lastBlock: bigint): Promise<void> {
  await sql`
    INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
    VALUES (${TASK}, ${contract}, ${lastBlock.toString()}::bigint, NOW())
    ON CONFLICT (task, scope) DO UPDATE SET
      last_block = EXCLUDED.last_block, last_run_at = NOW()
  `
}

async function tokenIsKnown(contract: string, tokenId: bigint): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM artist_tokens
    WHERE lower(contract) = ${contract} AND token_id = ${tokenId.toString()}
    LIMIT 1
  `) as Array<{ "?column?": number }>
  return rows.length > 0
}

export async function scanTokenTransfers(): Promise<TaskResult> {
  const contracts = await getContracts()
  let rpcCalls = 0
  let rowsWritten = 0

  const headBlock = await client.getBlockNumber()
  rpcCalls += 1

  for (const contract of contracts) {
    try {
      let fromBlock = await getCursor(contract)
      if (fromBlock === null) {
        // First scan ever for this contract — start at the earliest
        // known mint of tokens we care about. Side-steps a 5-year
        // shared-contract scan.
        fromBlock = await getEarliestMintBlock(contract)
      } else {
        fromBlock = fromBlock + 1n
      }

      let cursor = fromBlock
      while (cursor <= headBlock) {
        const toBlock = cursor + MAX_BLOCKS_PER_SCAN > headBlock
          ? headBlock
          : cursor + MAX_BLOCKS_PER_SCAN

        const logs = await client.getLogs({
          address: getAddress(contract) as Address,
          event: TRANSFER_EVENT,
          fromBlock: cursor,
          toBlock,
        })
        rpcCalls += 1

        for (const log of logs) {
          if (!log.args.tokenId) continue
          const tokenId = log.args.tokenId
          if (!(await tokenIsKnown(contract, tokenId))) continue
          const blockTime = 0n // timestamp can be filled lazily if needed; skip the eth_getBlockByNumber to save RPC

          await sql.begin(async (tx) => {
            await tx`
              INSERT INTO token_transfers
                (contract, token_id, from_addr, to_addr, block_number, log_index, tx_hash, block_time)
              VALUES
                (${contract}, ${tokenId.toString()}, ${(log.args.from ?? "0x0000000000000000000000000000000000000000").toLowerCase()},
                 ${(log.args.to ?? "0x0000000000000000000000000000000000000000").toLowerCase()},
                 ${log.blockNumber!.toString()}::bigint, ${log.logIndex!}, ${log.transactionHash!}, ${blockTime.toString()}::bigint)
              ON CONFLICT (contract, token_id, tx_hash, log_index) DO NOTHING
            `
            await tx`
              INSERT INTO token_owners
                (contract, token_id, owner, transferred_at_block, transferred_at_time, tx_hash)
              VALUES
                (${contract}, ${tokenId.toString()},
                 ${(log.args.to ?? "0x0000000000000000000000000000000000000000").toLowerCase()},
                 ${log.blockNumber!.toString()}::bigint, ${blockTime.toString()}::bigint, ${log.transactionHash!})
              ON CONFLICT (contract, token_id) DO UPDATE SET
                owner = EXCLUDED.owner,
                transferred_at_block = EXCLUDED.transferred_at_block,
                transferred_at_time = EXCLUDED.transferred_at_time,
                tx_hash = EXCLUDED.tx_hash
              WHERE token_owners.transferred_at_block <= EXCLUDED.transferred_at_block
            `
            rowsWritten += 1
          })
        }

        cursor = toBlock + 1n
        await setCursor(contract, toBlock)

        // Cap per-task wall time — let the next interval pick up where
        // we left off rather than blocking other tasks.
        if (cursor > fromBlock + MAX_BLOCKS_PER_SCAN * MAX_CHUNKS_PER_CONTRACT) break
      }
    } catch (err) {
      console.error(`[scan-token-transfers] ${contract}:`, err)
    }
  }

  return { scopeCount: contracts.length, rpcCalls, rowsWritten }
}
