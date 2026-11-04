/**
 * Validate an eth_getLogs response before any row is written from it.
 *
 * A fetch that returns something it shouldn't is treated as a failed
 * fetch (thrown inside scan-range's `fetch`, so the range is split and
 * retried, and never recorded as scanned):
 *
 *   - A log whose block number is outside the requested [from, to]: the
 *     provider ignored or clamped the range (a lagging or misbehaving
 *     node, see finality.ts).
 *   - A pending log (null block number / log index / tx hash).
 *   - A placeholder log index. The 016 incident stored logIndex
 *     4294967295 (0xffffffff), a sentinel some provider returned; since
 *     log_index is part of token_transfers' PK, the same log fetched via
 *     two providers was stored twice under two keys (audit M7).
 *
 * Pure module, unit-tested.
 */

/** 0xffffffff, the placeholder some providers return for "unknown". */
export const PLACEHOLDER_LOG_INDEX = 4_294_967_295

export function isValidLogIndex(i: unknown): i is number {
  return (
    typeof i === "number" &&
    Number.isSafeInteger(i) &&
    i >= 0 &&
    i < PLACEHOLDER_LOG_INDEX
  )
}

export class InvalidLogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidLogError"
  }
}

export type GuardedLog = {
  blockNumber: bigint | null
  logIndex: number | null
  transactionHash: string | null
}

/**
 * Throw InvalidLogError if any log is pending, out of range, or carries
 * a placeholder index. Returns the logs typed as mined.
 */
export function assertLogsInRange<T extends GuardedLog>(
  logs: readonly T[],
  from: bigint,
  to: bigint,
  label = "getLogs",
): Array<T & { blockNumber: bigint; logIndex: number; transactionHash: string }> {
  for (const log of logs) {
    if (log.blockNumber === null || log.blockNumber === undefined) {
      throw new InvalidLogError(`${label} ${from}-${to}: pending log (no block number)`)
    }
    if (log.blockNumber < from || log.blockNumber > to) {
      throw new InvalidLogError(
        `${label} ${from}-${to}: log at block ${log.blockNumber} is outside the requested range`,
      )
    }
    if (!isValidLogIndex(log.logIndex)) {
      throw new InvalidLogError(
        `${label} ${from}-${to}: invalid log index ${String(log.logIndex)} at block ${log.blockNumber}`,
      )
    }
    if (!log.transactionHash) {
      throw new InvalidLogError(`${label} ${from}-${to}: log at block ${log.blockNumber} has no tx hash`)
    }
  }
  return logs as Array<T & { blockNumber: bigint; logIndex: number; transactionHash: string }>
}
