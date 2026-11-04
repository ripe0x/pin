/**
 * For every contract in `artist_tokens`, scan ERC-721 Transfer events
 * from `worker_cursors.last_block` forward. Upsert ownership into
 * `token_owners`; append history rows to `token_transfers`.
 *
 * Critical optimization: for the first-time backfill of a contract,
 * cursor starts at MIN(mint_block) FROM artist_tokens WHERE contract=$1
 * — bounds the scan to "transfers of tokens we actually care about,"
 * not the contract's full deploy-to-head range.
 *
 * The web app reads token_owners directly. After this task has caught
 * up, every /collector/[address] inverse query is a Postgres point
 * lookup with zero external API calls.
 *
 * Each tick (#295):
 *   1. Drain a bounded batch of zero-time rows (block-time backfill).
 *   2. Forward scan, batched: contracts are grouped into multi-address
 *      eth_getLogs calls (up to TRANSFER_SCAN_ADDRESSES_PER_CALL, default
 *      50) by cursor bucket; see transfer-batches.ts for the grouping and
 *      why per-contract cursor semantics survive it. Each group walks
 *      with scan-range (failing ranges are split, never skipped) up to
 *      the finalized safe head (finality.ts), replaying a small overlap.
 *      A contract that keeps failing is isolated, then backed off
 *      (backoff.ts) instead of being retried every tick.
 *   3. Transfer-history backfill (transfer-backfill.ts, migration 030):
 *      tokens discovered after this cursor passed their blocks get their
 *      earlier transfers filled from their mint block, bounded per tick.
 *
 * ERC-1155 Mint clones (platform 'mint') are not scanned: they never
 * emit the ERC-721 Transfer event this task reads.
 *
 * Block timestamps: every transfer/owner row carries the real block time,
 * resolved once per block (deduped + globally throttled). Rows this scanner
 * wrote before it resolved times were stored with block_time = 0; the inline
 * `backfillBlockTimes` step drains those to real values over subsequent ticks.
 */
import { sql } from "../db.ts"
import { client, safeHead } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import { parseAbiItem, getAddress, type Address } from "viem"
import type { TaskResult } from "../scheduler.ts"
import { describeScanError, scanRange } from "../scan-range.ts"
import { assertLogsInRange } from "../log-guard.ts"
import { advanceCursors, scanWindow } from "../cursors.ts"
import { replayOverlap } from "../finality.ts"
import {
  backoffDelayMs, clearBackoff, loadBackoff, recordFailure, toPgTextArray,
  type BackoffPolicy,
} from "../backoff.ts"
import {
  DEFAULT_ADDRESSES_PER_CALL, memberCursorUpdates, ownsLog, planTransferBatches,
} from "../transfer-batches.ts"
import { planBackfill } from "../transfer-backfill.ts"

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const ZERO = "0x0000000000000000000000000000000000000000"
// drpc free tier caps eth_getLogs at 10,000 blocks per call. Stay under
// with margin.
const MAX_BLOCKS_PER_SCAN = 9_500n
// Per-group chunk budget per tick: the next interval picks up where this
// one stopped, so the task doesn't starve the others under drpc's
// free-tier budget.
const MAX_CHUNKS_PER_BATCH = 10
// Transfer-history backfill budget per tick, across all contracts.
const MAX_BACKFILL_CHUNKS_PER_TICK = 20
const MAX_BACKFILL_ROWS_PER_TICK = 5_000
// Queued tokens per contract up to which the backfill filters getLogs by
// tokenId topic (smaller responses on busy contracts).
const MAX_TOKEN_TOPIC_FILTER = 100
const TASK = "scan-token-transfers"
const INTERVAL_MS = 5 * 60_000
const BACKOFF: BackoffPolicy = { baseMs: INTERVAL_MS, maxMs: 24 * 60 * 60_000 }
// A group failure is recorded against every member with no delay; a
// contract with this many failures is scanned alone next time.
const GROUP_FAILURE: BackoffPolicy = { baseMs: 0, maxMs: 0 }
// One-time historical backfill of real block timestamps into rows this scanner
// wrote with block_time = 0 before it resolved timestamps. Bounded per tick.
const MAX_BACKFILL_BLOCKS_PER_RUN = 100

function addressesPerCall(): number {
  const n = Number(process.env.TRANSFER_SCAN_ADDRESSES_PER_CALL)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ADDRESSES_PER_CALL
}

type ScopeRow = { contract: string; last_block: string | null; min_block: string | null }

async function getScopes(): Promise<ScopeRow[]> {
  // Exclude shared-platform contracts (Foundation shared 1/1, SR V2
  // shared): single high-volume contracts shared by thousands of
  // artists, the exact unbounded scan v2 avoids. Exclude Mint clones
  // too: ERC-1155, never emit ERC-721 Transfer. `contract` is stored
  // lowercase by every writer, so the cursor join is a PK lookup.
  return (await sql`
    SELECT c.contract,
           w.last_block::text  AS last_block,
           c.min_block::text   AS min_block
    FROM (
      SELECT contract, MIN(mint_block) AS min_block
      FROM artist_tokens
      WHERE platform NOT IN ('fnd-shared', 'srv2-shared', 'mint')
      GROUP BY contract
    ) c
    LEFT JOIN worker_cursors w ON w.task = ${TASK} AND w.scope = c.contract
    ORDER BY c.contract
  `) as ScopeRow[]
}

/**
 * Resolve and persist real block timestamps for transfer/owner rows written
 * before this scanner carried block times (stored with block_time = 0 /
 * transferred_at_time = 0). Processes a bounded batch of DISTINCT zero-time
 * blocks per call; idempotent and self-draining. Migration 032 indexes the
 * zero-time rows so this is an index scan, not a seq scan, every tick.
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
    const updated = await sql`
      UPDATE token_transfers
      SET block_time = ${ts.toString()}::bigint
      WHERE block_number = ${bn.toString()}::bigint AND block_time = 0
    `
    rowsWritten += updated.count
    await sql`
      UPDATE token_owners
      SET transferred_at_time = ${ts.toString()}::bigint
      WHERE transferred_at_block = ${bn.toString()}::bigint
        AND transferred_at_time = 0
    `
  }
  return rowsWritten
}

type TransferLog = {
  address: string
  blockNumber: bigint
  logIndex: number
  transactionHash: string
  args: { from?: string; to?: string; tokenId?: bigint }
}

async function fetchTransfers(
  addresses: string[], from: bigint, to: bigint, tokenIds?: bigint[],
): Promise<TransferLog[]> {
  await throttleRpc()
  const logs = await client.getLogs({
    address: addresses.map((a) => getAddress(a) as Address),
    event: TRANSFER_EVENT,
    ...(tokenIds && tokenIds.length > 0 ? { args: { tokenId: tokenIds } } : {}),
    fromBlock: from,
    toBlock: to,
  })
  return assertLogsInRange(logs, from, to, TASK) as TransferLog[]
}

/**
 * Write the transfers of KNOWN tokens (in artist_tokens) from one fetched
 * range. Unknown tokens are skipped; the backfill queue (migration 030)
 * covers tokens discovered later. Known-ness is one query per range, not
 * one per log. Returns rows actually inserted into token_transfers.
 */
async function writeTransfers(
  logs: TransferLog[],
  blockTimeFor: (bn: bigint) => Promise<bigint>,
): Promise<number> {
  // tokenId 0 is a real token (L1): test for undefined, not falsiness.
  const candidates = logs.filter((l) => l.args.tokenId !== undefined)
  if (candidates.length === 0) return 0

  const contracts = candidates.map((l) => l.address.toLowerCase())
  const ids = candidates.map((l) => l.args.tokenId!.toString())
  const knownRows = (await sql`
    SELECT contract, token_id FROM artist_tokens
    WHERE (contract, token_id) IN (
      SELECT * FROM unnest(${contracts}::text[], ${ids}::text[])
    )
  `) as Array<{ contract: string; token_id: string }>
  const known = new Set(knownRows.map((r) => `${r.contract}:${r.token_id}`))

  let inserted = 0
  for (const log of candidates) {
    const contract = log.address.toLowerCase()
    const tokenId = log.args.tokenId!.toString()
    if (!known.has(`${contract}:${tokenId}`)) continue
    // Real block timestamp so provenance/history rows carry true dates.
    const blockTime = await blockTimeFor(log.blockNumber)
    const fromAddr = (log.args.from ?? ZERO).toLowerCase()
    const toAddr = (log.args.to ?? ZERO).toLowerCase()

    await sql.begin(async (tx) => {
      const r = await tx`
        INSERT INTO token_transfers
          (contract, token_id, from_addr, to_addr, block_number, log_index, tx_hash, block_time)
        VALUES
          (${contract}, ${tokenId}, ${fromAddr}, ${toAddr},
           ${log.blockNumber.toString()}::bigint, ${log.logIndex}, ${log.transactionHash},
           ${blockTime.toString()}::bigint)
        ON CONFLICT (contract, token_id, tx_hash, log_index) DO NOTHING
      `
      inserted += r.count
      await tx`
        INSERT INTO token_owners
          (contract, token_id, owner, transferred_at_block, transferred_at_time, tx_hash)
        VALUES
          (${contract}, ${tokenId}, ${toAddr},
           ${log.blockNumber.toString()}::bigint, ${blockTime.toString()}::bigint, ${log.transactionHash})
        ON CONFLICT (contract, token_id) DO UPDATE SET
          owner = EXCLUDED.owner,
          transferred_at_block = EXCLUDED.transferred_at_block,
          transferred_at_time = EXCLUDED.transferred_at_time,
          tx_hash = EXCLUDED.tx_hash
        WHERE token_owners.transferred_at_block <= EXCLUDED.transferred_at_block
      `
    })
  }
  return inserted
}

export async function scanTokenTransfers(): Promise<TaskResult> {
  let rpcCalls = 0
  let rowsWritten = 0
  const errors: string[] = []

  // Resolve each distinct block's timestamp at most once per run.
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

  rowsWritten += await backfillBlockTimes(blockTimeFor)

  const head = await safeHead.get()
  rpcCalls += head.rpcCalls
  const overlap = replayOverlap()

  // ── Forward scan, batched ────────────────────────────────────────────
  const scopes = await getScopes()
  const backoff = await loadBackoff(sql, TASK)
  const now = new Date()
  const windows = scopes.flatMap((s) => {
    const w = scanWindow({
      cursor: s.last_block === null ? null : BigInt(s.last_block),
      initialFrom: s.min_block === null ? 0n : BigInt(s.min_block),
      safeHead: head.block,
      overlap,
    })
    return w ? [{ contract: s.contract, from: w.from, backoff: backoff.get(s.contract) }] : []
  })
  const plan = planTransferBatches(windows, {
    now,
    maxAddresses: addressesPerCall(),
    maxSpan: MAX_BLOCKS_PER_SCAN,
  })
  if (plan.deferred.length > 0) {
    console.warn(`[${TASK}] ${plan.deferred.length} contract(s) backed off this tick: ${plan.deferred.slice(0, 10).join(", ")}`)
  }

  for (const batch of plan.batches) {
    const memberFrom = new Map(batch.members.map((m) => [m.contract, m.from]))
    const addresses = batch.members.map((m) => m.contract)
    const label = batch.solo
      ? `${TASK} ${addresses[0]}`
      : `${TASK} batch of ${addresses.length} from ${batch.from}`
    const scan = await scanRange<TransferLog[]>({
      from: batch.from,
      to: head.block,
      chunkSize: MAX_BLOCKS_PER_SCAN,
      maxChunks: MAX_CHUNKS_PER_BATCH,
      label,
      fetch: (a, b) => fetchTransfers(addresses, a, b),
      process: async (logs) => {
        // A member that starts above the group's start already has the
        // blocks below its own `from`; skip them (writes are idempotent
        // anyway, this keeps rowsWritten honest and the DB quiet).
        const owned = logs.filter((l) => {
          const from = memberFrom.get(l.address.toLowerCase())
          return from !== undefined && ownsLog(from, l.blockNumber)
        })
        rowsWritten += await writeTransfers(owned, blockTimeFor)
      },
      commit: (scannedTo) =>
        advanceCursors(sql, TASK, memberCursorUpdates(batch.members, scannedTo), scannedTo),
      onSplit: (a, b, err) =>
        console.warn(`[${label}] getLogs ${a}-${b} failed, splitting: ${err}`),
    })
    rpcCalls += scan.calls

    if (scan.error) {
      console.error(`[${label}] stopped at a failing range, cursors held at ${scan.scannedTo}:`, scan.error)
      errors.push(describeScanError(batch.solo ? addresses[0] : `batch(${addresses.length})`, scan.error))
      const policy = batch.solo ? BACKOFF : GROUP_FAILURE
      for (const contract of addresses) {
        await recordFailure(sql, TASK, backoff.get(contract), contract, scan.error.message, policy, now)
          .catch((err) => console.error(`[${TASK}] record failure ${contract}:`, err))
      }
    } else {
      const recovered = addresses.filter((c) => backoff.has(c))
      await clearBackoff(sql, TASK, recovered)
        .catch((err) => console.error(`[${TASK}] clear backoff:`, err))
    }
  }

  // ── Transfer-history backfill for late-discovered tokens ─────────────
  const bf = await drainBackfillQueue(blockTimeFor)
  rpcCalls += bf.rpcCalls
  rowsWritten += bf.rowsWritten
  errors.push(...bf.errors)

  return { scopeCount: scopes.length, rpcCalls, rowsWritten, errors }
}

async function drainBackfillQueue(
  blockTimeFor: (bn: bigint) => Promise<bigint>,
): Promise<{ rpcCalls: number; rowsWritten: number; errors: string[] }> {
  const out = { rpcCalls: 0, rowsWritten: 0, errors: [] as string[] }

  const queued = (await sql`
    SELECT contract, token_id, next_block::text AS next_block, failures
    FROM transfer_backfill_queue
    WHERE next_attempt_at <= NOW()
    ORDER BY contract, token_id
    LIMIT ${MAX_BACKFILL_ROWS_PER_TICK}
  `) as Array<{ contract: string; token_id: string; next_block: string; failures: number }>
  if (queued.length === 0) return out

  const contracts = Array.from(new Set(queued.map((q) => q.contract)))
  const cursorRows = (await sql`
    SELECT scope, last_block::text AS last_block FROM worker_cursors
    WHERE task = ${TASK} AND scope = ANY(${contracts}::text[])
  `) as Array<{ scope: string; last_block: string }>
  const floorRows = (await sql`
    SELECT contract, (MIN(mint_block) FILTER (WHERE mint_block > 0))::text AS floor
    FROM artist_tokens WHERE contract = ANY(${contracts}::text[])
    GROUP BY contract
  `) as Array<{ contract: string; floor: string | null }>

  const plan = planBackfill(
    queued.map((q) => ({ contract: q.contract, tokenId: q.token_id, nextBlock: BigInt(q.next_block) })),
    {
      cursorByContract: new Map(cursorRows.map((r) => [r.scope, BigInt(r.last_block)])),
      floorByContract: new Map(
        floorRows.filter((r) => r.floor !== null).map((r) => [r.contract, BigInt(r.floor!)]),
      ),
    },
  )

  for (const d of plan.done) await deleteQueued(d.contract, d.tokenIds)

  const failuresByKey = new Map(queued.map((q) => [`${q.contract}:${q.token_id}`, Number(q.failures)]))
  let budget = MAX_BACKFILL_CHUNKS_PER_TICK
  for (const w of plan.work) {
    if (budget <= 0) break
    const tokenFilter = w.tokenIds.length <= MAX_TOKEN_TOPIC_FILTER
      ? w.tokenIds.map((t) => BigInt(t))
      : undefined
    const scan = await scanRange<TransferLog[]>({
      from: w.from,
      to: w.to,
      chunkSize: MAX_BLOCKS_PER_SCAN,
      maxChunks: budget,
      label: `${TASK}.backfill ${w.contract}`,
      fetch: (a, b) => fetchTransfers([w.contract], a, b, tokenFilter),
      process: async (logs) => {
        out.rowsWritten += await writeTransfers(logs, blockTimeFor)
      },
      onSplit: (a, b, err) =>
        console.warn(`[${TASK}.backfill] ${w.contract} ${a}-${b} failed, splitting: ${err}`),
    })
    budget -= scan.chunks
    out.rpcCalls += scan.calls

    if (scan.scannedTo >= w.to) {
      await deleteQueued(w.contract, w.tokenIds)
    } else if (scan.scannedTo >= w.from) {
      await sql`
        UPDATE transfer_backfill_queue
        SET next_block = GREATEST(next_block, ${(scan.scannedTo + 1n).toString()}::bigint),
            updated_at = NOW()
        WHERE contract = ${w.contract} AND token_id = ANY(${w.tokenIds}::text[])
      `
    }
    if (scan.error) {
      const failures = Math.max(...w.tokenIds.map((t) => failuresByKey.get(`${w.contract}:${t}`) ?? 0)) + 1
      const delayMs = backoffDelayMs(failures, BACKOFF)
      out.errors.push(describeScanError(`backfill ${w.contract}`, scan.error))
      await sql`
        UPDATE transfer_backfill_queue
        SET failures = failures + 1,
            next_attempt_at = NOW() + (${String(delayMs)}::bigint * interval '1 millisecond'),
            last_error = ${scan.error.message.slice(0, 1_000)},
            updated_at = NOW()
        WHERE contract = ${w.contract} AND token_id = ANY(${w.tokenIds}::text[])
      `
    }
  }
  return out
}

async function deleteQueued(contract: string, tokenIds: string[]): Promise<void> {
  if (tokenIds.length === 0) return
  await sql.unsafe(
    "DELETE FROM transfer_backfill_queue WHERE contract = $1 AND token_id = ANY($2::text[])",
    [contract, toPgTextArray(tokenIds)],
  )
}
