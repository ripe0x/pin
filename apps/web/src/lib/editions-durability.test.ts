/**
 * Run with:
 *   node --experimental-strip-types --test apps/web/src/lib/editions-durability.test.ts
 *
 * Pure-function tests for the Phase 3 honest-status durability dimension
 * (docs/editions-permanence-funding.md). These pin the honest-status rule: only
 * a resolved Arweave floor is "permanent"; a hot pin is funded-then-lapsed and
 * never reads as permanent.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  durabilityIsPermanent,
  durabilityLabel,
  formatFundedThrough,
  renewalSignal,
  resolveArtworkDurability,
} from "./editions-durability.ts"

const NOW = 1_800_000_000 // fixed unix seconds
const DAY = 86_400

test("a resolved Arweave copy is the permanent floor", () => {
  assert.equal(
    resolveArtworkDurability({ kind: "arweave", retrievable: true, nowSec: NOW }),
    "permanent-floor",
  )
})

test("an Arweave copy that has NOT resolved is not yet permanent", () => {
  // unprobed or failed → not earned. Falls through to hot/none.
  assert.equal(
    resolveArtworkDurability({ kind: "arweave", retrievable: null, nowSec: NOW }),
    "none",
  )
  assert.equal(
    resolveArtworkDurability({ kind: "arweave", retrievable: false, nowSec: NOW }),
    "none",
  )
})

test("the Arweave floor wins over a hot pin when both exist", () => {
  assert.equal(
    resolveArtworkDurability({
      kind: "arweave",
      retrievable: true,
      fundedThrough: NOW - DAY, // hot pin lapsed, but floor is permanent
      nowSec: NOW,
    }),
    "permanent-floor",
  )
})

test("a hot pin is funded until its date, then lapsed", () => {
  assert.equal(
    resolveArtworkDurability({ kind: "ipfs", retrievable: true, fundedThrough: NOW + DAY, nowSec: NOW }),
    "hot-funded",
  )
  assert.equal(
    resolveArtworkDurability({ kind: "ipfs", retrievable: true, fundedThrough: NOW - 1, nowSec: NOW }),
    "hot-lapsed",
  )
})

test("no floor and no funded pin is none", () => {
  assert.equal(
    resolveArtworkDurability({ kind: "ipfs", retrievable: true, nowSec: NOW }),
    "none",
  )
  assert.equal(
    resolveArtworkDurability({ kind: "external", retrievable: null, nowSec: NOW }),
    "none",
  )
})

test("renewalSignal: none / ok / due-soon / lapsed", () => {
  const leadSec = 30 * DAY
  assert.equal(renewalSignal({ fundedThrough: null, nowSec: NOW, leadSec }), "none")
  assert.equal(renewalSignal({ fundedThrough: NOW + 60 * DAY, nowSec: NOW, leadSec }), "ok")
  assert.equal(renewalSignal({ fundedThrough: NOW + 10 * DAY, nowSec: NOW, leadSec }), "due-soon")
  assert.equal(renewalSignal({ fundedThrough: NOW, nowSec: NOW, leadSec }), "lapsed")
  assert.equal(renewalSignal({ fundedThrough: NOW - DAY, nowSec: NOW, leadSec }), "lapsed")
})

test("durabilityIsPermanent is true ONLY for permanent-floor", () => {
  assert.equal(durabilityIsPermanent("permanent-floor"), true)
  assert.equal(durabilityIsPermanent("hot-funded"), false)
  assert.equal(durabilityIsPermanent("hot-lapsed"), false)
  assert.equal(durabilityIsPermanent("none"), false)
})

test("durabilityLabel never calls a hot/lapsed state permanent", () => {
  assert.match(durabilityLabel("permanent-floor"), /permanent/i)
  assert.doesNotMatch(durabilityLabel("hot-funded", NOW + DAY), /permanent/i)
  assert.doesNotMatch(durabilityLabel("hot-lapsed"), /permanent/i)
  assert.doesNotMatch(durabilityLabel("none"), /permanent/i)
})

test("durabilityLabel shows the funded-through date for hot-funded", () => {
  const label = durabilityLabel("hot-funded", NOW + DAY)
  assert.match(label, new RegExp(formatFundedThrough(NOW + DAY)))
})

test("formatFundedThrough is deterministic UTC YYYY-MM-DD", () => {
  assert.equal(formatFundedThrough(1_800_000_000), "2027-01-15")
})
