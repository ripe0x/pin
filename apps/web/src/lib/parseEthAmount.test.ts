/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/parseEthAmount.test.ts
 *
 * Tests live alongside the parser they cover. We use Node's built-in test
 * runner + native TypeScript stripping (Node 22+) to avoid pulling in a
 * test framework just for one pure function. If/when the repo grows real
 * UI tests this can move to vitest without rewriting any cases.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { cleanEthAmountInput, parseEthAmount } from "./parseEthAmount.ts"

function showResult(r: ReturnType<typeof parseEthAmount>): string {
  if (r.ok) return `{ ok: true, wei: ${r.wei}n, canonical: ${JSON.stringify(r.canonical)} }`
  return `{ ok: false, reason: ${JSON.stringify(r.reason)} }`
}

function expectOk(input: string, expectedWei: bigint, expectedCanonical?: string) {
  const r = parseEthAmount(input)
  assert.equal(r.ok, true, `expected ok for ${JSON.stringify(input)}, got ${showResult(r)}`)
  if (r.ok) {
    assert.equal(r.wei, expectedWei, `wei mismatch for ${JSON.stringify(input)}: got ${r.wei}n, expected ${expectedWei}n`)
    if (expectedCanonical !== undefined) {
      assert.equal(r.canonical, expectedCanonical, `canonical mismatch for ${JSON.stringify(input)}`)
    }
  }
}

function expectReject(input: string, reasonSubstring?: string) {
  const r = parseEthAmount(input)
  assert.equal(r.ok, false, `expected reject for ${JSON.stringify(input)}, got ${showResult(r)}`)
  if (!r.ok && reasonSubstring) {
    assert.ok(
      r.reason.includes(reasonSubstring),
      `reason ${JSON.stringify(r.reason)} should contain ${JSON.stringify(reasonSubstring)}`,
    )
  }
}

const ETH = 10n ** 18n

test("happy path: standard dot decimal", () => {
  expectOk("0.5", ETH / 2n, "0.5")
  expectOk("1", ETH, "1")
  expectOk("1.25", (ETH * 5n) / 4n, "1.25")
  expectOk("0", 0n, "0")
})

test("the bug report: comma as decimal separator", () => {
  expectOk("0,5", ETH / 2n, "0.5")
  expectOk("1,25", (ETH * 5n) / 4n, "1.25")
})

test("US thousands separator with dot decimal", () => {
  expectOk("1,000.50", 1000n * ETH + ETH / 2n, "1000.5")
  expectOk("1,000,000.5", 1_000_000n * ETH + ETH / 2n)
})

test("EU thousands separator with comma decimal", () => {
  expectOk("1.000,50", 1000n * ETH + ETH / 2n, "1000.5")
  expectOk("1.000.000,5", 1_000_000n * ETH + ETH / 2n)
})

test("strips whitespace including NBSP", () => {
  expectOk("  0.5  ", ETH / 2n)
  expectOk("0.5 ", ETH / 2n)
  expectOk("1 000.5", 1000n * ETH + ETH / 2n) // thin space
})

test("rejects empty / whitespace-only", () => {
  expectReject("", "Enter")
  expectReject("   ", "Enter")
})

test("single separator of any type is the decimal point", () => {
  // Documented behavior: a US user typing "1,000" expecting 1000 ETH gets
  // 1 ETH instead. The displayed parsed value below the input surfaces the
  // mistake. We refuse to silently guess thousands without disambiguation.
  expectOk("1,000", ETH, "1")
  expectOk("1.000", ETH, "1")
})

test("rejects multiple separators of the same type with no decimal", () => {
  // "1,000,000" (commas only) is ambiguous — could be 1M ETH (US thousands)
  // or a typo. Force the user to disambiguate by adding a decimal.
  expectReject("1,000,000", "Only one decimal")
  expectReject("1.000.000", "Only one decimal")
})

test("rejects multiple decimal points", () => {
  expectReject("0.5.5", "Only one decimal")
})

test("rejects negative and signed", () => {
  expectReject("-0.5", "Negative")
  expectReject("+0.5", "Negative")
})

test("rejects scientific notation", () => {
  expectReject("1e18", "Scientific")
  expectReject("1.5E2", "Scientific")
})

test("rejects non-numeric chars", () => {
  expectReject("abc", "digits")
  expectReject("0.5 ETH", "digits")
  expectReject("$0.5", "digits")
})

test("rejects more than 18 decimal places", () => {
  expectReject("0.1234567890123456789", "18 decimal")
  expectOk("0.123456789012345678", 123456789012345678n)
})

test("rejects invalid thousands grouping", () => {
  expectReject("1,00.5", "every 3 digits")
  expectReject("12,34,567.5", "every 3 digits")
})

test("normalizes leading and trailing edge cases", () => {
  expectOk("0.", 0n, "0")
  expectOk(".5", ETH / 2n, "0.5")
  expectOk(",5", ETH / 2n, "0.5")
  expectReject("00.5", "leading zeros")
})

test("trims trailing fractional zeros in canonical", () => {
  expectOk("0.500", ETH / 2n, "0.5")
  expectOk("1.0", ETH, "1")
})

// ─── cleanEthAmountInput ───────────────────────────────────────────────────

test("cleanEthAmountInput strips letters and symbols", () => {
  assert.equal(cleanEthAmountInput("0.5 ETH"), "0.5")
  assert.equal(cleanEthAmountInput("$0.5"), "0.5")
  assert.equal(cleanEthAmountInput("abc0.5xyz"), "0.5")
  assert.equal(cleanEthAmountInput("0.5€"), "0.5")
})

test("cleanEthAmountInput swaps single comma to period", () => {
  assert.equal(cleanEthAmountInput("0,5"), "0.5")
  assert.equal(cleanEthAmountInput("0,073181745"), "0.073181745")
  assert.equal(cleanEthAmountInput(",5"), ".5")
})

test("cleanEthAmountInput leaves mixed-separator input alone", () => {
  // US thousands: 1,000.50 → don't swap (parser handles)
  assert.equal(cleanEthAmountInput("1,000.50"), "1,000.50")
  // EU thousands: 1.000,50 → don't swap (parser handles)
  assert.equal(cleanEthAmountInput("1.000,50"), "1.000,50")
})

test("cleanEthAmountInput leaves multiple commas alone", () => {
  // "1,000,000" → don't try to guess; parser will reject
  assert.equal(cleanEthAmountInput("1,000,000"), "1,000,000")
})

test("cleanEthAmountInput preserves mid-typing states", () => {
  // User typed "0," — swap to "0." so they can keep typing
  assert.equal(cleanEthAmountInput("0,"), "0.")
  // Empty stays empty
  assert.equal(cleanEthAmountInput(""), "")
})

test("cleanEthAmountInput strips whitespace", () => {
  assert.equal(cleanEthAmountInput("  0.5  "), "0.5")
  assert.equal(cleanEthAmountInput("0.5 "), "0.5")
})
