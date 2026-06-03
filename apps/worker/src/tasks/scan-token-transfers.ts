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
 *
 * Block timestamps: every transfer/owner row carries the real block time,
 * resolved once per block (deduped + globally throttled). Rows this scanner
 * wrote before it resolved times were stored with block_time = 0; the inline
 * `backfillBlockTimes` step drains those to real values over subsequent ticks.
 * This is what makes the token page's provenance timeline show true dates
 * instead of the Unix epoch.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import { parseAbiItem, getAddress, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin.
const MAX_BLOCKS_PER_SCAN = 9_500n
// Per-task wall-time cap: process up to N chunks per contract per task
// invocation, then let the next interval pick up where we left off.
// Kept low so this task (which has the most contracts) doesn't starve
// the others under drpc's free-tier budget.
const MAX_CHUNKS_PER_CONTRACT = 10n
const TASK = "scan-token-transfers"
// One-time historical backfill of real block timestamps into rows this scanner
// wrote with block_time = 0 before it resolved timestamps. Bounded per tick so
// the drain spreads across many runs and never dominates the shared 2 req/s RPC
// budget; a no-op once every row has a real time. Tunable — raising it drains
// faster at the cost of a bigger per-tick RPC share. eth_getBlockByNumber is
// served by the free public RPCs (Alchemy is only the last-resort backstop), so
// the dollar cost of the drain is ~zero; this bound is purely about pacing.
const MAX_BACKFILL_BLOCKS_PER_RUN = 100

async function getContracts(): Promise<string[]> {
  // Exclude shared-platform contracts (Foundation shared 1/1, SR V2
  // shared). Those are single high-volume contracts shared by thousands
  // of artists — scanning every Transfer on them to find our handful of
  // known-artist tokens would be the exact unbounded scan v2 is built to
  // avoid. Owner for those tokens is resolved inline at mint-discovery
  // time (resolveNewTokenOwner); per-token transfer history isn't worth
  // a full-contract scan.
  const rows = (await sql`
    SELECT DISTINCT lower(contract) AS contract FROM artist_tokens
    WHERE platform NOT IN ('fnd-shared', 'srv2-shared')
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

/**
 * Resolve and persist real block timestamps for transfer/owner rows written
 * before this scanner carried block times (stored with block_time = 0 /
 * transferred_at_time = 0 to save an eth_getBlockByNumber). Processes a bounded
 * batch of DISTINCT zero-time blocks per call. Block timestamps are immutable,
 * so each block is resolved exactly once, ever, and that one timestamp fills
 * every transfer in the block plus the matching current-owner row. Both updates
 * are guarded on the 0 sentinel, so the drain is idempotent and never clobbers
 * a real time. Self-draining: returns 0 work once no zero-time rows remain.
 */
async function backfillBlockTimes(
  blockTimeFor: (bn: bigint) => Promise<bigint>,
): Promise<number> {
  const blocks = (await sql`
    SELECT DISTINCT block_number::text AS block_number
    FROM token_transfers
    WHERE block_time = 0
    ORDER BY block_number
    LIMIT ${MAX_BACKFILL_BLOCKS_PER_RUN}
  `) as Array<{ block_number: string }>

  let rowsWritten = 0
  for (const { block_number } of blocks) {
    const bn = BigInt(block_number)
    let ts: bigint
    try {
      ts = await blockTimeFor(bn)
    } catch (err) {
      console.error(`[${TASK}] backfill getBlock ${bn}:`, err)
      continue
    }
    const updated = (await sql`
      UPDATE token_transfers
      SET block_time = ${ts.toString()}::bigint
      WHERE block_number = ${bn.toString()}::bigint AND block_time = 0
      RETURNING 1 AS n
    `) as Array<{ n: number }>
    rowsWritten += updated.length
    await sql`
      UPDATE token_owners
      SET transferred_at_time = ${ts.toString()}::bigint
      WHERE transferred_at_block = ${bn.toString()}::bigint
        AND transferred_at_time = 0
    `
  }
  return rowsWritten
}

export async function scanTokenTransfers(): Promise<TaskResult> {
  const contracts = await getContracts()
  let rpcCalls = 0
  let rowsWritten = 0

  // Resolve each distinct block's timestamp at most once (block times are
  // immutable, so the cache is valid for the whole run). Shared by the
  // historical backfill and the forward scan below — a block touched by both
  // costs a single eth_getBlockByNumber.
  const blockTimeCache = new Map<bigint, bigint>()
  const blockTimeFor = async (bn: bigint): Promise<bigint> => {
    const cached = blockTimeCache.get(bn)
    if (cached !== undefined) return cached
    await throttleRpc()
    const blk = await client.getBlock({ blockNumber: bn })
    rpcCalls += 1
    blockTimeCache.set(bn, blk.timestamp)
    return blk.timestamp
  }

  // Drain a bounded batch of pre-existing zero-time rows before the forward
  // scan. No-op once fully backfilled.
  rowsWritten += await backfillBlockTimes(blockTimeFor)

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

        await throttleRpc()
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
          // Real block timestamp so provenance/history rows carry true dates.
          // Deduped per block + globally throttled via blockTimeFor, so a block
          // with many known-token transfers costs one eth_getBlockByNumber.
          const blockTime = await blockTimeFor(log.blockNumber!)

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
