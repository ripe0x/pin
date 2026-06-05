/**
 * Run with:
 *   node --experimental-strip-types --test apps/web/src/lib/pnd-editions.test.ts
 *
 * Pure-function tests for the Phase 1 mint-funded permanence split math
 * (docs/editions-permanence-funding.md). The contribution mechanic routes a
 * `permanence` slice of every mint to an artist-owned vault by making the vault
 * one more recipient in the 0xSplits payout split. These tests pin down the two
 * 0xSplits invariants the create flow must never violate: accounts sorted
 * ascending, and allocations summing to EXACTLY 1_000_000.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import type { Address } from "viem"
import {
  buildSplitArgsWithPermanence,
  validatePermanence,
  type Collaborator,
} from "./editions-split.ts"

const A = "0x1111111111111111111111111111111111111111" as Address
const B = "0x2222222222222222222222222222222222222222" as Address
const C = "0x3333333333333333333333333333333333333333" as Address
const VAULT = "0x9999999999999999999999999999999999999999" as Address

const SCALE = 1_000_000
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const isSortedAsc = (xs: Address[]) =>
  xs.every((x, i) => i === 0 || xs[i - 1].toLowerCase() < x.toLowerCase())

test("no permanence slice falls back to plain split args", () => {
  const rows: Collaborator[] = [
    { address: B, percent: 60 },
    { address: A, percent: 40 },
  ]
  const { accounts, allocations } = buildSplitArgsWithPermanence(rows, null)
  assert.deepEqual(accounts, [A, B]) // sorted ascending
  assert.deepEqual(allocations, [400_000, 600_000])
  assert.equal(sum(allocations), SCALE)
})

test("artist-alone + permanence yields a clean two-recipient split", () => {
  // The common case: no collaborators, just carve a slice to the vault.
  const { accounts, allocations } = buildSplitArgsWithPermanence(
    [{ address: A, percent: 100 }],
    { vault: VAULT, percent: 5 },
  )
  assert.equal(accounts.length, 2)
  assert.ok(isSortedAsc(accounts))
  assert.equal(sum(allocations), SCALE)
  // vault gets 5% = 50_000; artist gets the remaining 95% = 950_000.
  const vaultIdx = accounts.findIndex((a) => a.toLowerCase() === VAULT.toLowerCase())
  assert.equal(allocations[vaultIdx], 50_000)
  const artistIdx = accounts.findIndex((a) => a.toLowerCase() === A.toLowerCase())
  assert.equal(allocations[artistIdx], 950_000)
})

test("permanence dilutes collaborators proportionally and still sums to SCALE", () => {
  // 60/40 collaborators, 10% permanence: the base pool shrinks to 90%, split
  // 60/40 -> 54% / 36%, vault 10%.
  const { accounts, allocations } = buildSplitArgsWithPermanence(
    [
      { address: A, percent: 60 },
      { address: B, percent: 40 },
    ],
    { vault: VAULT, percent: 10 },
  )
  assert.equal(accounts.length, 3)
  assert.ok(isSortedAsc(accounts))
  assert.equal(sum(allocations), SCALE)
  const at = (addr: Address) => allocations[accounts.findIndex((a) => a.toLowerCase() === addr.toLowerCase())]
  assert.equal(at(VAULT), 100_000) // 10%
  assert.equal(at(A), 540_000) // 54%
  assert.equal(at(B), 360_000) // 36%
})

test("rounding drift is absorbed so allocations sum to EXACTLY 1_000_000", () => {
  // Three equal collaborators (33/33/34 would be uneven); use 1/1/1-style
  // proportions that don't divide evenly into the post-slice remainder.
  const { allocations } = buildSplitArgsWithPermanence(
    [
      { address: A, percent: 33 },
      { address: B, percent: 33 },
      { address: C, percent: 34 },
    ],
    { vault: VAULT, percent: 7 },
  )
  // The whole point: 0xSplits rejects any total != 1_000_000.
  assert.equal(sum(allocations), SCALE)
})

test("every allocation is a positive integer", () => {
  const { allocations } = buildSplitArgsWithPermanence(
    [
      { address: A, percent: 1 },
      { address: B, percent: 99 },
    ],
    { vault: VAULT, percent: 1 },
  )
  assert.equal(sum(allocations), SCALE)
  for (const a of allocations) {
    assert.ok(Number.isInteger(a), `allocation ${a} is not an integer`)
    assert.ok(a > 0, `allocation ${a} is not positive`)
  }
})

test("validatePermanence rejects a bad address", () => {
  const r = validatePermanence("not-an-address", "5", [A])
  assert.equal(r.ok, false)
  assert.match(r.error ?? "", /invalid vault/i)
})

test("validatePermanence rejects out-of-range / non-integer shares", () => {
  for (const pct of ["0", "100", "5.5", "-1", ""]) {
    const r = validatePermanence(VAULT, pct, [A])
    assert.equal(r.ok, false, `expected ${pct} to be rejected`)
  }
  assert.equal(validatePermanence(VAULT, "1", [A]).ok, true)
  assert.equal(validatePermanence(VAULT, "99", [A]).ok, true)
})

test("validatePermanence rejects a vault that collides with a base recipient", () => {
  const r = validatePermanence(A, "5", [A, B])
  assert.equal(r.ok, false)
  assert.match(r.error ?? "", /differ/i)
  // case-insensitive collision
  const r2 = validatePermanence(A.toUpperCase().replace("0X", "0x"), "5", [A])
  assert.equal(r2.ok, false)
})

test("validatePermanence accepts a distinct vault", () => {
  const r = validatePermanence(VAULT, "5", [A, B])
  assert.equal(r.ok, true)
  assert.deepEqual(r.parsed, { vault: VAULT, percent: 5 })
})
