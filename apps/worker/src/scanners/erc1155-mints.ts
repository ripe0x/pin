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
 * deduped. `token_1155_mints` keeps one row per mint event, keyed on
 * (tx_hash, log_index, token_id), so it is idempotent too, which is what
 * lets the scan replay a small overlap below its cursor (cursors.ts).
 *
 * The walk goes through scan-range up to the safe head (finality.ts);
 * both event kinds are fetched together per range, so a TransferSingle
 * success can't advance the cursor past a failed TransferBatch read. The
 * error, if any, is RETURNED for TaskResult.errors, and with a `backoff`
 * context a failing scope is skipped for an exponentially growing time.
 */
import type { Sql } from "postgres"
import {
  parseAbiItem, getAddress, type Address, type PublicClient,
} from "viem"
import { resolveNewTokenOwner } from "./resolve-owner.ts"
import { throttleRpc } from "../throttle.ts"
import { scanRange } from "../scan-range.ts"
import { assertLogsInRange } from "../log-guard.ts"
import { advanceCursor, readCursor, scanWindow } from "../cursors.ts"
import { replayOverlap, type SafeHeadReader } from "../finality.ts"
import { withBackoff, type BackoffContext } from "../backoff.ts"

const TRANSFER_SINGLE = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
)
const TRANSFER_BATCH = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
)
const ZERO = "0x0000000000000000000000000000000000000000"
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin. Per-tick chunk budget kept low so each cycle leaves
// budget for other tasks; backfill spread across many cycles is fine.
const MAX_BLOCKS_PER_SCAN = 9_500n
const MAX_ITERATIONS_PER_CALL = 15

export type Erc1155ScanArgs = {
  sql: Sql
  client: PublicClient
  safeHead: SafeHeadReader
  taskName: string
  platform: string
  artist: string
  contract: string
  contractDeployBlock: bigint
  /** Scheduled tasks pass their backoff rows; refresh-artist omits it. */
  backoff?: BackoffContext
}

export type Erc1155ScanResult = {
  rpcCalls: number
  rowsWritten: number
  /** Why the scan stopped short, or null. The cursor is held there. */
  error: string | null
  /** True when the scope was skipped because it is backed off. */
  skipped?: boolean
}

type Mint = {
  tokenId: string
  to: string
  amount: bigint
  blockNumber: bigint
  logIndex: number
  txHash: string
}

export async function scanErc1155MintsFromZero(
  args: Erc1155ScanArgs,
): Promise<Erc1155ScanResult> {
  const { sql, taskName, artist, contract } = args
  const scope = `${artist}:${contract}`
  const r = await withBackoff(sql, taskName, scope, args.backoff, () => scanScope(args, scope))
  return "skipped" in r ? { rpcCalls: 0, rowsWritten: 0, error: null, skipped: true } : r
}

async function scanScope(args: Erc1155ScanArgs, scope: string): Promise<Erc1155ScanResult> {
  const { sql, client, taskName, platform, artist, contract, contractDeployBlock } = args

  const head = await args.safeHead.get()
  let rpcCalls = head.rpcCalls
  let rowsWritten = 0

  const window = scanWindow({
    cursor: await readCursor(sql, taskName, scope),
    initialFrom: contractDeployBlock,
    safeHead: head.block,
    overlap: replayOverlap(),
  })
  if (!window) return { rpcCalls, rowsWritten, error: null }

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

  const label = `${taskName} ${scope}`
  const scan = await scanRange<Mint[]>({
    from: window.from,
    to: window.to,
    chunkSize: MAX_BLOCKS_PER_SCAN,
    maxChunks: MAX_ITERATIONS_PER_CALL,
    label,
    fetch: async (a, b) => {
      const out: Mint[] = []
      await throttleRpc()
      const singles = assertLogsInRange(await client.getLogs({
        address: getAddress(contract) as Address,
        event: TRANSFER_SINGLE,
        args: { from: ZERO as `0x${string}` },
        fromBlock: a,
        toBlock: b,
      }), a, b, label)
      for (const log of singles) {
        if (log.args.id === undefined) continue
        out.push({
          tokenId: log.args.id.toString(),
          to: (log.args.to as string).toLowerCase(),
          amount: (log.args.value as bigint | undefined) ?? 0n,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          txHash: log.transactionHash,
        })
      }

      await throttleRpc()
      const batches = assertLogsInRange(await client.getLogs({
        address: getAddress(contract) as Address,
        event: TRANSFER_BATCH,
        args: { from: ZERO as `0x${string}` },
        fromBlock: a,
        toBlock: b,
      }), a, b, label)
      for (const log of batches) {
        const ids = (log.args.ids ?? []) as readonly bigint[]
        const values = (log.args.values ?? []) as readonly bigint[]
        // One mint-history row per id in the batch. ids[i] ↔ values[i].
        for (let i = 0; i < ids.length; i++) {
          out.push({
            tokenId: ids[i].toString(),
            to: (log.args.to as string).toLowerCase(),
            amount: values[i] ?? 0n,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            txHash: log.transactionHash,
          })
        }
      }
      return out
    },
    process: async (mints) => {
      for (const m of mints) {
        // Resolve the block time first so the artist_tokens row can carry
        // mint_time (first mint wins via ON CONFLICT DO NOTHING).
        const ts = await blockTimeFor(m.blockNumber)
        const inserted = await sql`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index, mint_time, first_seen_at)
          VALUES
            (${artist}, ${contract}, ${m.tokenId}, ${platform},
             ${m.blockNumber.toString()}::bigint, ${m.logIndex}, ${ts.toString()}::bigint, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
        `
        rowsWritten += inserted.count
        // Mint-history row. One row per mint event (PK includes log_index),
        // not deduped by tokenId — that's what drives edition supply
        // (Σ amount) and the mint timeline.
        const minted = await sql`
          INSERT INTO token_1155_mints
            (contract, token_id, to_addr, amount, block_number, block_time, tx_hash, log_index)
          VALUES
            (${contract}, ${m.tokenId}, ${m.to}, ${m.amount.toString()},
             ${m.blockNumber.toString()}::bigint, ${ts.toString()}::bigint, ${m.txHash}, ${m.logIndex})
          ON CONFLICT (tx_hash, log_index, token_id) DO NOTHING
        `
        rowsWritten += minted.count
        if (inserted.count > 0) {
          await resolveNewTokenOwner({ sql, client, contract, tokenId: m.tokenId })
          rpcCalls += 1
        }
      }
    },
    commit: (scannedTo) => advanceCursor(sql, taskName, scope, scannedTo),
    onSplit: (a, b, err) =>
      console.warn(`[${taskName}] ${scope} getLogs ${a}-${b} failed, splitting: ${err}`),
  })
  // Two getLogs (single + batch) per fetch attempt; an upper bound when
  // the first of the two fails.
  rpcCalls += scan.calls * 2

  if (scan.error) {
    console.error(`[${taskName}] ${scope}: stopped at a failing range, cursor held at ${scan.scannedTo}:`, scan.error.message)
  }
  return { rpcCalls, rowsWritten, error: scan.error ? scan.error.message : null }
}
