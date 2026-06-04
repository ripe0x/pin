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
  fundedForLabel,
  perMintLabel,
  perMintPinUsd,
  pinYearsLabel,
  pinYearsPerMint,
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

test("perMintPinUsd nets out the surface share", () => {
  // 0.05 ETH, 3% slice, 10% surface, $3000 -> 0.05*0.9*0.03*3000 = $4.05
  const usd = perMintPinUsd({
    priceWei: 50_000_000_000_000_000n,
    permanenceBps: 300,
    surfaceBps: 1000,
    ethUsd: 3000,
  })
  assert.ok(Math.abs(usd - 4.05) < 1e-6, `got ${usd}`)
  // no surface -> $4.50
  const direct = perMintPinUsd({
    priceWei: 50_000_000_000_000_000n,
    permanenceBps: 300,
    surfaceBps: 0,
    ethUsd: 3000,
  })
  assert.ok(Math.abs(direct - 4.5) < 1e-6, `got ${direct}`)
})

test("pinYearsPerMint: ~1 year per mint for a ~3.375 GB work", () => {
  // perMintUsd $4.05 / (3.375 GB * $1.2/GB/yr = $4.05) = 1.0 year per mint
  const y = pinYearsPerMint({
    priceWei: 50_000_000_000_000_000n,
    permanenceBps: 300,
    surfaceBps: 1000,
    ethUsd: 3000,
    artworkBytes: 3_375_000_000,
  })
  assert.ok(Math.abs(y - 1) < 0.01, `got ${y}`)
  // a tiny 25 MB work is far cheaper -> many years per mint
  const tiny = pinYearsPerMint({
    priceWei: 50_000_000_000_000_000n,
    permanenceBps: 300,
    surfaceBps: 1000,
    ethUsd: 3000,
    artworkBytes: 25_000_000,
  })
  assert.ok(tiny > 100, `got ${tiny}`)
})

test("perMintLabel renders +yr / +days / —", () => {
  assert.equal(perMintLabel(1), "+1 yr / mint")
  assert.equal(perMintLabel(2.4), "+2 yr / mint")
  assert.equal(perMintLabel(0.08), "+29 d / mint")
  assert.equal(perMintLabel(0), "—")
})

test("pinYearsLabel clamps and never shows an absurd number", () => {
  assert.equal(pinYearsLabel(2500), "100+ years")
  assert.equal(pinYearsLabel(100), "100+ years")
  assert.equal(pinYearsLabel(3), "~3 years")
  assert.equal(pinYearsLabel(1), "~1 year")
  assert.equal(pinYearsLabel(0.5), "~6 months")
  assert.equal(pinYearsLabel(0), "—")
})

test("fundedForLabel renders years / months / lapsed", () => {
  const YEAR = 365 * 86_400
  assert.equal(fundedForLabel(NOW + 3 * YEAR, NOW), "~3 years")
  assert.equal(fundedForLabel(NOW + YEAR, NOW), "~1 year")
  assert.equal(fundedForLabel(NOW + Math.round(1.5 * YEAR), NOW), "~1.5 years")
  assert.equal(fundedForLabel(NOW + 8 * 30 * 86_400, NOW), "~8 months")
  assert.equal(fundedForLabel(NOW - DAY, NOW), "lapsed")
})
