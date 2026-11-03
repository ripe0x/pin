/**
 * Contiguous block-range scanning that never records a failed range as
 * scanned.
 *
 * Every cursored scanner in the worker has the same shape: walk
 * `[from, to]` in fixed-size chunks, fetch something per chunk (getLogs,
 * trace_filter), write rows, then persist "scanned up to block N". The
 * bug this helper exists to prevent (issue #295, audit C1) is turning an
 * RPC failure into an empty success: catch the error, treat the chunk as
 * having no logs, and advance the cursor past it. Nothing ever revisits
 * that window, so every mint or deploy in it is lost for good.
 *
 * Contract:
 *   - Chunks are processed strictly in order. `scannedTo` is the last
 *     block of the last range that was BOTH fetched and processed
 *     without error, or `from - 1n` when nothing succeeded. A caller
 *     that persists `scannedTo` can never skip a block.
 *   - A failing fetch is split in half and each half retried (left half
 *     first, so progress is contiguous), recursively, until the range is
 *     no larger than `minChunkSize`. This handles provider range and
 *     result-size rejections on busy contracts. If a range at the floor
 *     still fails, the scan stops there and returns the error.
 *   - An error from `process` or `commit` (a DB write, say) also stops
 *     the scan, without splitting: splitting can't fix a write failure.
 *
 * The helper itself never throws for a fetch/process failure; it returns
 * `{ scannedTo, error }` so the caller can persist the partial cursor
 * first and then surface the error (see `TaskResult.errors` in
 * scheduler.ts, which marks the iteration as failed).
 *
 * Pure module (no DB/RPC imports) so it's unit-testable with a fake
 * fetcher.
 */

export const DEFAULT_MIN_CHUNK_SIZE = 100n

export class ScanRangeError extends Error {
  readonly from: bigint
  readonly to: bigint

  constructor(label: string, from: bigint, to: bigint, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`${label} blocks ${from}-${to}: ${reason}`, { cause })
    this.name = "ScanRangeError"
    this.from = from
    this.to = to
  }
}

export type ScanRangeOptions<T> = {
  /** First block to scan (inclusive). */
  from: bigint
  /** Last block to scan (inclusive), usually the chain head. */
  to: bigint
  /** Size of a top-level chunk, e.g. a provider's eth_getLogs cap. */
  chunkSize: bigint
  /**
   * Smallest range a failing chunk is split down to. A failure at or
   * below this size stops the scan. Defaults to 100 blocks.
   */
  minChunkSize?: bigint
  /**
   * Budget of top-level chunks per call (splits don't count against it).
   * The scan ends early, without error, once it is spent; the cursor
   * resumes from `scannedTo + 1n` next tick.
   */
  maxChunks?: number
  /** Fetch one range. Throw on any RPC failure; never return a placeholder. */
  fetch: (from: bigint, to: bigint) => Promise<T>
  /** Handle one successfully fetched range (write rows, collect state). */
  process?: (data: T, from: bigint, to: bigint) => Promise<void> | void
  /**
   * Called after each successfully processed range with the new
   * `scannedTo`, e.g. to persist the cursor incrementally on long scans.
   */
  commit?: (scannedTo: bigint) => Promise<void> | void
  /** Called when a failing range is split, for logging. */
  onSplit?: (from: bigint, to: bigint, err: unknown) => void
  /** Prefix for the error message. */
  label?: string
}

export type ScanRangeResult = {
  /** Last block fully fetched and processed; `from - 1n` if none. */
  scannedTo: bigint
  /** Number of fetch attempts, including retries of split halves. */
  calls: number
  /** Number of top-level chunks attempted. */
  chunks: number
  /** The failure that stopped the scan, or null if it ran clean. */
  error: ScanRangeError | null
}

export async function scanRange<T>(opts: ScanRangeOptions<T>): Promise<ScanRangeResult> {
  const { from, to, fetch, process, commit, onSplit } = opts
  const label = opts.label ?? "scan"
  const chunkSize = opts.chunkSize
  const floor = opts.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE
  const maxChunks = opts.maxChunks ?? Number.POSITIVE_INFINITY
  if (chunkSize < 1n) throw new Error("scanRange: chunkSize must be >= 1")
  if (floor < 1n) throw new Error("scanRange: minChunkSize must be >= 1")

  let scannedTo = from - 1n
  let calls = 0
  let chunks = 0
  let error: ScanRangeError | null = null

  // Returns true when [a, b] was fully fetched + processed.
  async function scanSpan(a: bigint, b: bigint): Promise<boolean> {
    let data: T
    try {
      calls++
      data = await fetch(a, b)
    } catch (err) {
      const size = b - a + 1n
      if (size <= floor || size < 2n) {
        error = new ScanRangeError(label, a, b, err)
        return false
      }
      onSplit?.(a, b, err)
      const mid = a + size / 2n - 1n
      if (!(await scanSpan(a, mid))) return false
      return scanSpan(mid + 1n, b)
    }
    try {
      await process?.(data, a, b)
      scannedTo = b
      await commit?.(b)
    } catch (err) {
      error = new ScanRangeError(label, a, b, err)
      return false
    }
    return true
  }

  let cursor = from
  while (cursor <= to && chunks < maxChunks) {
    const end = cursor + chunkSize - 1n > to ? to : cursor + chunkSize - 1n
    chunks++
    if (!(await scanSpan(cursor, end))) break
    cursor = end + 1n
  }

  return { scannedTo, calls, chunks, error }
}

/** Message list for `TaskResult.errors`, with the scope prefixed. */
export function describeScanError(scope: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `${scope}: ${msg}`
}
