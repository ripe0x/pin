/**
 * ERC-1155 holder balances for the contracts known artists deployed
 * (#296; migration 034; erc1155-balances.ts has the ledger + balance
 * rules and the scope query).
 *
 * Every TransferSingle / TransferBatch on each in-scope contract, mints
 * and burns included, from the contract's first block, so balances are
 * complete once a contract's first backfill has caught up. Per tick:
 *
 *   - Scopes: Mint protocol clones and is_erc1155 Manifold cores of
 *     known_artists (the spend ceiling). Per-contract cursor in
 *     worker_cursors (task 'scan-1155-balances', scope = contract).
 *   - Batched like scan-token-transfers (transfer-batches.ts): contracts
 *     whose windows start close together share one multi-address
 *     eth_getLogs that asks for BOTH events at once (topic0 OR), so a
 *     caught-up fleet costs ceil(contracts / 50) calls per tick and a
 *     TransferSingle success can't advance a cursor past a failed
 *     TransferBatch read.
 *   - Each group walks scan-range (failing ranges split, never recorded
 *     as scanned) up to the finalized safe head (finality.ts), replaying
 *     SCAN_REPLAY_OVERLAP blocks below each cursor. The ledger insert is
 *     idempotent, so the replay is free.
 *   - A range's ledger rows and the recompute of the balances they touch
 *     commit in ONE transaction, before the cursor moves (scan-range's
 *     commit runs after process), so a crash between them can't leave a
 *     cursor ahead of its balances.
 *   - A group failure is recorded against every member with no delay; a
 *     member with repeated failures is scanned alone and then backs off
 *     exponentially (backoff.ts), so one poisoned contract can't hold
 *     the rest hostage.
 *
 * Holder counts (token_1155_stats.owner_count) are derived from these
 * balances by scan-1155-stats once a contract has caught up.
 */
import { parseAbiItem, getAddress, type Address } from "viem"
import { sql } from "../db.ts"
import { client, safeHead } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import { INDEXER_SCHEMA } from "../indexer-schema.ts"
import type { TaskResult } from "../scheduler.ts"
import { describeScanError, scanRange } from "../scan-range.ts"
import { assertLogsInRange } from "../log-guard.ts"
import { advanceCursors, scanWindow } from "../cursors.ts"
import { replayOverlap } from "../finality.ts"
import {
  clearBackoff, loadBackoff, recordFailure, type BackoffPolicy,
} from "../backoff.ts"
import {
  DEFAULT_ADDRESSES_PER_CALL, memberCursorUpdates, ownsLog, planTransferBatches,
} from "../transfer-batches.ts"
import {
  LEDGER_INSERT_SQL, RECOMPUTE_SQL, affectedTokens, erc1155ScopesSql,
  expandTransferLogs, ledgerInsertParams, recomputeParams,
  type Erc1155Log, type LedgerRow,
} from "../erc1155-balances.ts"

export const TASK = "scan-1155-balances"
const INTERVAL_MS = 15 * 60_000
// drpc free tier caps eth_getLogs at 10,000 blocks per call.
const MAX_BLOCKS_PER_SCAN = 9_500n
// Per-group chunk budget per tick; a backfill resumes next tick.
const MAX_CHUNKS_PER_BATCH = 10
const BACKOFF: BackoffPolicy = { baseMs: INTERVAL_MS, maxMs: 24 * 60 * 60_000 }
const GROUP_FAILURE: BackoffPolicy = { baseMs: 0, maxMs: 0 }

const TRANSFER_SINGLE = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
)
const TRANSFER_BATCH = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
)

function addressesPerCall(): number {
  const n = Number(process.env.TRANSFER_SCAN_ADDRESSES_PER_CALL)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ADDRESSES_PER_CALL
}

async function fetchTransfers(addresses: string[], from: bigint, to: bigint): Promise<Erc1155Log[]> {
  await throttleRpc()
  const logs = await client.getLogs({
    address: addresses.map((a) => getAddress(a) as Address),
    events: [TRANSFER_SINGLE, TRANSFER_BATCH],
    fromBlock: from,
    toBlock: to,
  })
  return assertLogsInRange(logs, from, to, TASK) as unknown as Erc1155Log[]
}

/** Ledger insert + balance recompute for one fetched range, atomically. */
async function applyRange(rows: LedgerRow[]): Promise<{ ledger: number; balances: number }> {
  if (rows.length === 0) return { ledger: 0, balances: 0 }
  return sql.begin(async (tx) => {
    const inserted = (await tx.unsafe(LEDGER_INSERT_SQL, ledgerInsertParams(rows))) as unknown as
      Array<{ contract: string; token_id: string }>
    if (inserted.length === 0) return { ledger: 0, balances: 0 }
    const tokens = affectedTokens(inserted.map((r) => ({ contract: r.contract, tokenId: r.token_id })))
    const res = (await tx.unsafe(RECOMPUTE_SQL, recomputeParams(tokens))) as unknown as
      Array<{ changed: number }>
    return { ledger: inserted.length, balances: Number(res[0]?.changed ?? 0) }
  })
}

export async function scan1155Balances(): Promise<TaskResult> {
  const scopes = (await sql.unsafe(erc1155ScopesSql(INDEXER_SCHEMA), [TASK])) as Array<{
    contract: string; start_block: string; last_block: string | null
  }>
  if (scopes.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  const head = await safeHead.get()
  let rpcCalls = head.rpcCalls
  let rowsWritten = 0
  const errors: string[] = []
  const overlap = replayOverlap()

  const backoff = await loadBackoff(sql, TASK)
  const now = new Date()
  const windows = scopes.flatMap((s) => {
    const w = scanWindow({
      cursor: s.last_block === null ? null : BigInt(s.last_block),
      initialFrom: BigInt(s.start_block),
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
    const scan = await scanRange<Erc1155Log[]>({
      from: batch.from,
      to: head.block,
      chunkSize: MAX_BLOCKS_PER_SCAN,
      maxChunks: MAX_CHUNKS_PER_BATCH,
      label,
      fetch: async (a, b) => {
        const logs = await fetchTransfers(addresses, a, b)
        // Validate (and expand) before process(): a malformed log fails
        // the fetch, so the range is split/retried instead of written.
        expandTransferLogs(logs)
        return logs
      },
      process: async (logs) => {
        // A member whose own window starts above the group's start already
        // has the earlier blocks; the ledger would dedupe them anyway.
        const owned = logs.filter((l) => {
          const from = memberFrom.get(l.address.toLowerCase())
          return from !== undefined && ownsLog(from, l.blockNumber)
        })
        const r = await applyRange(expandTransferLogs(owned))
        rowsWritten += r.ledger + r.balances
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

  return { scopeCount: scopes.length, rpcCalls, rowsWritten, errors }
}
