/**
 * Global RPC throttle. Every scanner that hits an RPC provider should
 * `await throttleRpc()` before issuing the call. The throttle enforces
 * a single global pace across all concurrent tasks: when N tasks are
 * each ready to issue a call, they serialize through this gate.
 *
 * Why a single global limiter, not per-provider:
 *   - drpc free tier rate-limits at the account level. Spreading the
 *     work across 4 fallback providers doesn't help — they all hit
 *     drpc eventually (via fallback on `getLogs` failures) and the
 *     drpc budget is what matters.
 *   - Each task's "running" flag prevents the same task from
 *     overlapping with itself; the throttle prevents DIFFERENT tasks
 *     from compounding burst rate.
 *
 * Default: 500ms between calls = max 2 req/sec sustained = ~172K
 * calls/day. Free tier should sustain this with margin.
 *
 * Tune via `RPC_DELAY_MS` env var on the worker service.
 */

const RPC_DELAY_MS = Number(process.env.RPC_DELAY_MS ?? "500")

let nextSlotAt = 0

/**
 * Wait for our turn in the global RPC queue. Single resolution point —
 * the awaiting Promise resumes when wall-clock crosses `nextSlotAt`.
 */
export async function throttleRpc(): Promise<void> {
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + RPC_DELAY_MS
  const wait = slot - now
  if (wait > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, wait))
  }
}
