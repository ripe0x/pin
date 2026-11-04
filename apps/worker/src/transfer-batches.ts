/**
 * Batch planning for scan-token-transfers' multi-address eth_getLogs
 * (audit M3, #295).
 *
 * The task used to make one getLogs call per contract per window, every
 * 5 minutes, about 306k calls/day. eth_getLogs takes an address ARRAY, so
 * one call can cover many contracts; the catch is that every contract
 * has its own cursor. The design:
 *
 *   1. Each contract's next window starts at `from` (its cursor + 1,
 *      minus the replay overlap; or its earliest mint on a first scan).
 *   2. Sort by `from` and cut greedy groups of at most `maxAddresses`
 *      contracts whose `from`s lie within `maxSpan` blocks of the
 *      group's lowest `from`. A group is scanned once, from that lowest
 *      `from` to the safe head, with scan-range.
 *   3. A member whose own `from` is above the group's start sees some
 *      blocks it already scanned. Its logs below its own `from` are
 *      dropped before writing (see `ownsLog`), and the writes are
 *      idempotent anyway (token_transfers PK + DO NOTHING, and the
 *      token_owners upsert only moves forward in block order).
 *   4. After the scan, a member's cursor moves to the group's
 *      `scannedTo` only if `scannedTo >= its own from`
 *      (`memberCursorUpdates`); a member that was ahead of where the
 *      group stopped keeps its cursor. Writes go through the GREATEST
 *      upsert, so nothing moves backwards.
 *
 * In steady state every caught-up contract has the same cursor (the last
 * safe head), so all of them fall into one span and the task makes about
 * ceil(contracts / 50) calls per tick instead of one per contract. A
 * contract still backfilling sits in its own span bucket and advances
 * with that bucket's chunk budget, as before.
 *
 * Failures (audit M2): a group failure can't say which member is to
 * blame (a busy contract blowing a provider's result-size limit, say).
 * Each member gets a failure recorded with no delay; once a contract has
 * `isolateAfter` failures it is scanned alone, and a solo failure backs
 * off exponentially (backoff.ts). A transient outage that lasts one tick
 * therefore doesn't explode the next tick into one call per contract,
 * and a persistently poisoned contract stops dragging its group down.
 *
 * Pure module, unit-tested.
 */
import { isBackedOff, type BackoffRow } from "./backoff.ts"

export type TransferScope = {
  contract: string
  /** First block this contract still needs scanned. */
  from: bigint
  backoff?: BackoffRow
}

export type TransferBatch = {
  /** Lowest `from` among the members; the group scans from here. */
  from: bigint
  members: Array<{ contract: string; from: bigint }>
  /** True for an isolated contract (failures >= isolateAfter). */
  solo: boolean
}

export type TransferPlan = {
  batches: TransferBatch[]
  /** Contracts skipped this tick because they are backed off. */
  deferred: string[]
}

export const DEFAULT_ADDRESSES_PER_CALL = 50
export const DEFAULT_ISOLATE_AFTER = 2

export function planTransferBatches(
  scopes: TransferScope[],
  opts: {
    now: Date
    maxAddresses?: number
    maxSpan: bigint
    isolateAfter?: number
  },
): TransferPlan {
  const maxAddresses = Math.max(1, opts.maxAddresses ?? DEFAULT_ADDRESSES_PER_CALL)
  const isolateAfter = opts.isolateAfter ?? DEFAULT_ISOLATE_AFTER
  const deferred: string[] = []
  const solo: TransferBatch[] = []
  const pool: Array<{ contract: string; from: bigint }> = []

  for (const s of scopes) {
    const failures = s.backoff?.failures ?? 0
    if (failures >= isolateAfter) {
      if (isBackedOff(s.backoff, opts.now)) {
        deferred.push(s.contract)
      } else {
        solo.push({ from: s.from, members: [{ contract: s.contract, from: s.from }], solo: true })
      }
      continue
    }
    pool.push({ contract: s.contract, from: s.from })
  }

  pool.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.contract.localeCompare(b.contract)))

  const batches: TransferBatch[] = []
  let current: TransferBatch | null = null
  for (const m of pool) {
    if (
      current === null ||
      current.members.length >= maxAddresses ||
      m.from - current.from > opts.maxSpan
    ) {
      current = { from: m.from, members: [], solo: false }
      batches.push(current)
    }
    current.members.push(m)
  }

  solo.sort((a, b) => a.members[0].contract.localeCompare(b.members[0].contract))
  return { batches: [...batches, ...solo], deferred: deferred.sort() }
}

/**
 * Contracts whose cursor may move to `scannedTo` after their group's
 * scan: the group covered every block from each such member's own
 * `from` up to `scannedTo`.
 */
export function memberCursorUpdates(
  members: Array<{ contract: string; from: bigint }>,
  scannedTo: bigint,
): string[] {
  return members.filter((m) => scannedTo >= m.from).map((m) => m.contract)
}

/** Whether a log at `block` is new for a member that starts at `from`. */
export function ownsLog(memberFrom: bigint, block: bigint): boolean {
  return block >= memberFrom
}
