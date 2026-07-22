/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/homage-quote-math.test.ts
 *
 * The Homage mint-quote scaling math, exercised with fixture numbers. Same
 * zero-framework pattern as mint-phases.test.ts: Node's built-in runner +
 * native type stripping. The invariants under test mirror what the contract
 * enforces at mint time: the scaled swap must clear the threshold (plus the
 * safety margin) at the observed pool rate, and everything over the
 * threshold is refund, never cost. `threshold` is a fixture value passed
 * explicitly, matching the live-read contract in homage-quote-math.ts.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { DEFAULT_SAFETY_BPS, price111PerEth, scaleSwapForThreshold, spotEthForThreshold } from "./homage-quote-math.ts"

const WAD = 10n ** 18n

// A sqrtPriceX96 fixture for a pool priced at exactly 4,000,000 $111 per ETH
// (both 1e18): sqrtP = sqrt(4e6) * 2^96 = 2000 * 2^96. Exact in integers, so
// the spot/price helpers can be asserted with equality.
const SQRT_P_4M = 2000n * (1n << 96n)

// Fixture threshold for these tests (independent of the deployed contract's
// actual `threshold()` value).
const THRESHOLD = 50_000n * WAD

test("price111PerEth: exact at a perfect-square price", () => {
  assert.equal(price111PerEth(SQRT_P_4M), 4_000_000n * WAD)
})

test("spotEthForThreshold: 50k $111 at 4M/ETH costs 0.0125 ETH spot", () => {
  // 50_000 / 4_000_000 = 0.0125 ETH
  assert.equal(spotEthForThreshold(SQRT_P_4M, THRESHOLD), (125n * WAD) / 10_000n)
})

test("spotEthForThreshold: throws on an uninitialized pool", () => {
  assert.throws(() => spotEthForThreshold(0n, THRESHOLD), /pool not initialized/)
})

test("scaleSwapForThreshold: clears the threshold + margin at the observed rate", () => {
  // Probe: 0.0125 ETH nets only 46,000 $111 (fees + skim + impact ate ~8%).
  const probeIn = (125n * WAD) / 10_000n
  const probeOut = 46_000n * WAD
  const q = scaleSwapForThreshold(probeIn, probeOut, THRESHOLD)
  // The estimated receive at the linear rate must clear the 5% target...
  const target = (THRESHOLD * BigInt(10_000 + DEFAULT_SAFETY_BPS)) / 10_000n
  assert.ok(q.estReceived >= target, `estReceived ${q.estReceived} < target ${target}`)
  // ...and the refund is exactly the excess over the threshold.
  assert.equal(q.estRefund, q.estReceived - THRESHOLD)
  // Sanity: scaling is ~ target/probeOut, so ethForSwap sits close to
  // probeIn * 52,500/46,000 (within the +1 wei floor guard).
  const expected = (probeIn * target) / probeOut + 1n
  assert.equal(q.ethForSwap, expected)
})

test("scaleSwapForThreshold: custom safety margin scales the target", () => {
  const probeIn = WAD / 100n
  const probeOut = 50_000n * WAD // pool quote exactly at threshold
  const q0 = scaleSwapForThreshold(probeIn, probeOut, THRESHOLD, 0)
  const q10 = scaleSwapForThreshold(probeIn, probeOut, THRESHOLD, 1000)
  // 0 bps: swap ~= probe (plus the +1 wei guard); 1000 bps: 10% more ETH in.
  assert.equal(q0.ethForSwap, probeIn + 1n)
  assert.equal(q10.ethForSwap, (probeIn * 11n) / 10n + 1n)
  assert.ok(q10.estReceived > q0.estReceived)
})

test("scaleSwapForThreshold: +1 wei guard keeps the floor from undershooting", () => {
  // An awkward rate where probeIn * target / probeOut floors: the estimated
  // receive computed back from the floored value must still be >= target.
  const probeIn = 3_333_333_333_333_333n
  const probeOut = 46_123_456_789_012_345_678_901n
  const target = (THRESHOLD * BigInt(10_000 + DEFAULT_SAFETY_BPS)) / 10_000n
  const q = scaleSwapForThreshold(probeIn, probeOut, THRESHOLD)
  assert.ok(q.estReceived >= target)
})

test("scaleSwapForThreshold: rejects degenerate probes", () => {
  assert.throws(() => scaleSwapForThreshold(0n, WAD, THRESHOLD), /bad probe/)
  assert.throws(() => scaleSwapForThreshold(WAD, 0n, THRESHOLD), /quote returned zero/)
})
