/**
 * Safe scan head (audit H1, #295).
 *
 * Every cursored scanner used to scan up to `latest`, as reported by
 * whichever provider in the viem `fallback` chain answered
 * `eth_blockNumber`. Two things go wrong at the tip:
 *
 *   1. Reorgs. Rows written from a block that is later orphaned are never
 *      reconciled, and in `token_transfers` a re-included transaction gets
 *      a new log_index, so the PK does not dedupe it.
 *   2. Lagging providers. The `getLogs` call can be served by a different
 *      provider than the one that reported the head. A node a few blocks
 *      behind returns empty or clamped results for blocks past its own
 *      head, and the scanner records them as scanned.
 *
 * Scanners now stop at a SAFE head instead:
 *
 *   - `finalized` mode (default): the `finalized` block tag. Finalized
 *     blocks cannot reorg, and the tag trails the tip by roughly two
 *     epochs (~64-95 blocks, ~13-19 min), so a provider would have to lag
 *     by more than that to clamp a range silently.
 *   - `confirmed` mode, and the fallback when a provider can't serve the
 *     `finalized` tag: `latest - SCAN_CONFIRMATIONS` (default 12 blocks,
 *     ~2.4 min). Used by the live auction trackers, whose writes are
 *     re-derived from live contract state every tick (see their headers),
 *     so they only need protection from lagging providers, not reorgs.
 *
 * Scanners whose writes are idempotent (ON CONFLICT DO NOTHING, or an
 * upsert keyed on the row's identity) also replay a small overlap below
 * their cursor (`SCAN_REPLAY_OVERLAP`, default 12 blocks; see
 * cursors.ts `scanWindow`), so a confirmations-mode head that was later
 * reorged is re-read.
 *
 * Lagging-provider detection beyond that margin: viem's fallback
 * transport doesn't say which provider served a given call, so a silent
 * clamp at the provider's own head isn't directly observable. What IS
 * observable is checked in log-guard.ts: a log outside the requested
 * range, a pending log (null block number), or a placeholder log index
 * fails the whole range instead of being written.
 *
 * Pure module (no rpc.ts / db.ts import) so it is unit-testable with a
 * fake client; rpc.ts wires the shared instance.
 */

export const DEFAULT_SCAN_CONFIRMATIONS = 12n
export const DEFAULT_REPLAY_OVERLAP = 12n
const DEFAULT_TTL_MS = 12_000

function parseBlockCount(env: string | undefined, fallback: bigint): bigint {
  if (env === undefined || env.trim() === "") return fallback
  if (!/^\d+$/.test(env.trim())) return fallback
  return BigInt(env.trim())
}

/** `SCAN_CONFIRMATIONS` env, default 12. Non-numeric values fall back. */
export function scanConfirmations(env: string | undefined = process.env.SCAN_CONFIRMATIONS): bigint {
  return parseBlockCount(env, DEFAULT_SCAN_CONFIRMATIONS)
}

/** `SCAN_REPLAY_OVERLAP` env, default 12. 0 disables the replay. */
export function replayOverlap(env: string | undefined = process.env.SCAN_REPLAY_OVERLAP): bigint {
  return parseBlockCount(env, DEFAULT_REPLAY_OVERLAP)
}

export type SafeHeadMode = "finalized" | "confirmed"

export type SafeHead = {
  /** Highest block a scanner may treat as scanned. */
  block: bigint
  /** Where `block` came from. */
  source: "finalized" | "confirmations"
  /** RPC calls this lookup cost (0 when served from the short cache). */
  rpcCalls: number
}

/**
 * Choose the safe head from what the providers reported. `finalized` is
 * null when the tag lookup failed or isn't supported; `latest` is null
 * when it wasn't fetched. Throws when neither is usable.
 */
export function pickSafeHead(input: {
  finalized: bigint | null
  latest: bigint | null
  confirmations: bigint
}): { block: bigint; source: SafeHead["source"] } {
  const { finalized, latest, confirmations } = input
  if (finalized !== null && finalized > 0n) {
    // A finalized block above another provider's latest means that
    // provider lags; never scan past what the laggard can serve.
    const block = latest !== null && latest < finalized ? latest : finalized
    return { block, source: "finalized" }
  }
  if (latest !== null) {
    const block = latest > confirmations ? latest - confirmations : 0n
    return { block, source: "confirmations" }
  }
  throw new Error("safe head: neither a finalized nor a latest block is available")
}

export type HeadClient = {
  getBlock: (args: { blockTag: "finalized" }) => Promise<{ number: bigint | null }>
  getBlockNumber: () => Promise<bigint>
}

export type SafeHeadReader = {
  get: (mode?: SafeHeadMode) => Promise<SafeHead>
}

/**
 * A safe-head reader with a short per-mode cache. Many scanners ask for
 * the head once per scope (scan-manifold asked once per contract); a
 * block every 12s means a 12s cache costs no freshness and saves the
 * repeat calls.
 */
export function createSafeHeadReader(
  client: HeadClient,
  opts: { confirmations?: bigint; ttlMs?: number; now?: () => number } = {},
): SafeHeadReader {
  const confirmations = opts.confirmations ?? scanConfirmations()
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now
  const cache = new Map<SafeHeadMode, { at: number; head: SafeHead }>()

  async function fetchHead(mode: SafeHeadMode): Promise<SafeHead> {
    let rpcCalls = 0
    let finalized: bigint | null = null
    if (mode === "finalized") {
      try {
        rpcCalls++
        const blk = await client.getBlock({ blockTag: "finalized" })
        finalized = blk.number ?? null
      } catch (err) {
        console.warn(
          `[worker.finality] finalized tag unavailable, falling back to latest - ${confirmations}: ` +
          (err instanceof Error ? err.message.split("\n")[0] : String(err)),
        )
      }
    }
    let latest: bigint | null = null
    if (finalized === null || finalized <= 0n) {
      rpcCalls++
      latest = await client.getBlockNumber()
    }
    return { ...pickSafeHead({ finalized, latest, confirmations }), rpcCalls }
  }

  return {
    async get(mode: SafeHeadMode = "finalized"): Promise<SafeHead> {
      const hit = cache.get(mode)
      const t = now()
      if (hit && t - hit.at < ttlMs) return { ...hit.head, rpcCalls: 0 }
      const head = await fetchHead(mode)
      cache.set(mode, { at: t, head })
      return head
    },
  }
}
