/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/mint-snapshot-overlay.test.ts
 *
 * Pure overlay math for the indexer-first snapshot (Phase 4.2). Same zero-
 * framework pattern as mint-phases.test.ts. Covers the merge contract: indexed
 * values REPLACE RPC values where present; nulls leave the RPC value in place
 * (partial sync); the phase shape is never dropped.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  overlayPhaseWindows,
  overallStartFromWindows,
  type IndexedSchedule,
  type PhaseWindowFns,
} from "./mint-snapshot-overlay.ts"
import { type PhaseWindow } from "./mint-phases.ts"

const PHASE_FNS: PhaseWindowFns[] = [
  { startFn: "claimStart", endFn: "allowlistStart" },
  { startFn: "allowlistStart", endFn: "publicStart" },
  { startFn: "publicStart" }, // open-ended
]

function baseWindows(claim: string, allow: string, pub: string): PhaseWindow[] {
  return [
    { key: "claim", label: "Claim", start: claim, end: allow },
    { key: "allowlist", label: "Allowlist", start: allow, end: pub },
    { key: "public", label: "Public", start: pub, end: "0" },
  ]
}

test("indexed schedule fully replaces the RPC windows", () => {
  const base = baseWindows("0", "0", "0") // RPC returned nothing (pre-read)
  const schedule: IndexedSchedule = {
    claimStart: "1000",
    allowlistStart: "2000",
    publicStart: "3000",
  }
  const out = overlayPhaseWindows(base, PHASE_FNS, schedule)
  assert.deepEqual(
    out.map((w) => [w.start, w.end]),
    [
      ["1000", "2000"],
      ["2000", "3000"],
      ["3000", "0"], // last phase open-ended: endFn absent → keeps base "0"
    ],
  )
  // Shape (keys/labels) preserved.
  assert.deepEqual(out.map((w) => w.key), ["claim", "allowlist", "public"])
})

test("a null indexed field leaves the RPC value in place (partial sync)", () => {
  const base = baseWindows("111", "222", "333") // RPC snapshot had values
  const schedule: IndexedSchedule = {
    claimStart: "1000",
    allowlistStart: null, // not yet indexed
    publicStart: "3000",
  }
  const out = overlayPhaseWindows(base, PHASE_FNS, schedule)
  // claim.start ← indexed; claim.end (allowlistStart) null → keeps RPC "222".
  assert.equal(out[0].start, "1000")
  assert.equal(out[0].end, "222")
  // allowlist.start (allowlistStart) null → keeps RPC "222"; end ← indexed 3000.
  assert.equal(out[1].start, "222")
  assert.equal(out[1].end, "3000")
  // public.start ← indexed 3000.
  assert.equal(out[2].start, "3000")
})

test("inputs are not mutated", () => {
  const base = baseWindows("0", "0", "0")
  const snapshot = JSON.stringify(base)
  overlayPhaseWindows(base, PHASE_FNS, {
    claimStart: "1",
    allowlistStart: "2",
    publicStart: "3",
  })
  assert.equal(JSON.stringify(base), snapshot)
})

test("overallStart is the earliest scheduled (nonzero) start", () => {
  const windows = baseWindows("3000", "2000", "5000")
  assert.equal(overallStartFromWindows(windows, "0"), "2000")
})

test("overallStart falls back when nothing is scheduled", () => {
  const windows = baseWindows("0", "0", "0")
  assert.equal(overallStartFromWindows(windows, "42"), "42")
})
