/**
 * Homage mint-quote math — the pure arithmetic behind the `homage-quote`
 * provider (mint-modules/homage.ts). Ported verbatim from the Homage repo's
 * `web/lib/homage.ts` `quoteMint` so the two mint frontends compute identical
 * numbers from identical inputs (the launch plan's consistency guard).
 *
 * The question the math answers: what ETH should `mint()` route into the
 * ETH → $111 v4 pool so the swap nets >= the contract's live escrow
 * threshold (`HomageMinter.threshold()`, owner-tunable, NOT a fixed value)?
 * The caller reads the pool spot (StateView `getSlot0`) to size a probe,
 * runs ONE real quote through the live pool (V4Quoter — reflects the LP fee,
 * the 6% skim, and price impact), and this module scales that observation
 * linearly to clear the threshold plus a small safety margin. The swap is
 * exact-input and the contract refunds all excess $111/ETH (reverting if it
 * underflows the threshold), so erring slightly high is safe and costs
 * nothing.
 *
 * `threshold` is a required parameter, not a module constant: it must come
 * from a live `threshold()` read. A hardcoded value here previously drifted
 * from the deployed default (50,000 hardcoded vs. 30,000 deployed), sizing
 * every swap ~67% too large.
 *
 * Kept free of viem / `@pin/*` / `@/` imports so the unit tests run under
 * `node --experimental-strip-types --test` without path-alias resolution
 * (same pattern as mint-phases.ts / mint-reveal.ts).
 */

const Q192 = 1n << 192n
const WAD = 10n ** 18n

/** Default headroom over the threshold, in bps (5%), to absorb price drift
 *  between quote and tx. Excess is refunded in the same transaction. */
export const DEFAULT_SAFETY_BPS = 500

export type SwapQuote = {
  /** ETH (wei) the mint should route into the pool. */
  ethForSwap: bigint
  /** ~$111 the swap nets at the probed rate (>= threshold + margin). */
  estReceived: bigint
  /** ~$111 over the threshold, refunded to the minter. */
  estRefund: bigint
}

/**
 * Naive spot ETH (wei) to buy exactly `threshold` $111 at the pool's current
 * price — no fee/skim/impact. Used as the quoter probe amount (and a display
 * reference). price = currency1/currency0 = sqrtP^2 / 2^192.
 */
export function spotEthForThreshold(sqrtPriceX96: bigint, threshold: bigint): bigint {
  if (sqrtPriceX96 === 0n) throw new Error("pool not initialized")
  return (threshold * Q192) / (sqrtPriceX96 * sqrtPriceX96)
}

/** $111 (1e18) per 1 ETH at the pool's current price, for display. */
export function price111PerEth(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * WAD) / Q192
}

/**
 * Scale one observed pool quote (probeIn -> probeOut) linearly so the swap
 * clears `threshold` plus `safetyBps` headroom. The +1 wei guards the
 * integer floor from undershooting the target at the observed rate.
 */
export function scaleSwapForThreshold(
  probeIn: bigint,
  probeOut: bigint,
  threshold: bigint,
  safetyBps: number = DEFAULT_SAFETY_BPS,
): SwapQuote {
  if (probeIn <= 0n) throw new Error("bad probe")
  if (probeOut === 0n) throw new Error("quote returned zero")
  const target = (threshold * BigInt(10_000 + safetyBps)) / 10_000n
  const ethForSwap = (probeIn * target) / probeOut + 1n
  const estReceived = (probeOut * ethForSwap) / probeIn
  const estRefund = estReceived > threshold ? estReceived - threshold : 0n
  return { ethForSwap, estReceived, estRefund }
}
