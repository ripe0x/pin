/**
 * Homage mint-quote math — the pure arithmetic behind the `homage-quote`
 * provider (mint-modules/homage.ts). Ported verbatim from the Homage repo's
 * `web/lib/homage.ts` `quoteMint` so the two mint frontends compute identical
 * numbers from identical inputs (the launch plan's consistency guard).
 *
 * The question the math answers: what ETH should `mint()` route into the
 * ETH → $111 v4 pool so the swap nets ≥ THRESHOLD (50,000) $111? The caller
 * reads the pool spot (StateView `getSlot0`) to size a probe, runs ONE real
 * quote through the live pool (V4Quoter — reflects the LP fee, the 6% skim,
 * and price impact), and this module scales that observation linearly to
 * clear THRESHOLD plus a small safety margin. The swap is exact-input and
 * the contract refunds all excess $111/ETH (reverting if it underflows
 * THRESHOLD), so erring slightly high is safe and costs nothing.
 *
 * Kept free of viem / `@pin/*` / `@/` imports so the unit tests run under
 * `node --experimental-strip-types --test` without path-alias resolution
 * (same pattern as mint-phases.ts / mint-reveal.ts).
 */

const Q192 = 1n << 192n
const WAD = 10n ** 18n

/** $111 escrowed per homage — mirrors `Homage.THRESHOLD` (50_000e18). */
export const HOMAGE_THRESHOLD = 50_000n * WAD

/** Default headroom over THRESHOLD, in bps (5%), to absorb price drift
 *  between quote and tx. Excess is refunded in the same transaction. */
export const DEFAULT_SAFETY_BPS = 500

export type SwapQuote = {
  /** ETH (wei) the mint should route into the pool. */
  ethForSwap: bigint
  /** ~$111 the swap nets at the probed rate (≥ THRESHOLD + margin). */
  estReceived: bigint
  /** ~$111 over THRESHOLD, refunded to the minter. */
  estRefund: bigint
}

/**
 * Naive spot ETH (wei) to buy exactly THRESHOLD $111 at the pool's current
 * price — no fee/skim/impact. Used as the quoter probe amount (and a display
 * reference). price = currency1/currency0 = sqrtP² / 2¹⁹².
 */
export function spotEthForThreshold(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) throw new Error("pool not initialized")
  return (HOMAGE_THRESHOLD * Q192) / (sqrtPriceX96 * sqrtPriceX96)
}

/** $111 (1e18) per 1 ETH at the pool's current price, for display. */
export function price111PerEth(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * WAD) / Q192
}

/**
 * Scale one observed pool quote (probeIn → probeOut) linearly so the swap
 * clears THRESHOLD plus `safetyBps` headroom. The +1 wei guards the integer
 * floor from undershooting the target at the observed rate.
 */
export function scaleSwapForThreshold(
  probeIn: bigint,
  probeOut: bigint,
  safetyBps: number = DEFAULT_SAFETY_BPS,
): SwapQuote {
  if (probeIn <= 0n) throw new Error("bad probe")
  if (probeOut === 0n) throw new Error("quote returned zero")
  const target = (HOMAGE_THRESHOLD * BigInt(10_000 + safetyBps)) / 10_000n
  const ethForSwap = (probeIn * target) / probeOut + 1n
  const estReceived = (probeOut * ethForSwap) / probeIn
  const estRefund = estReceived > HOMAGE_THRESHOLD ? estReceived - HOMAGE_THRESHOLD : 0n
  return { ethForSwap, estReceived, estRefund }
}
