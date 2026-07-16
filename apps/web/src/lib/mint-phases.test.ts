/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/mint-phases.test.ts
 *
 * Phase-window resolution for phased mints. Same zero-framework pattern as
 * parseEthAmount.test.ts: Node's built-in runner + native type stripping.
 * The scenarios mirror the Homage-style schedule the semantics were designed
 * for: three phases whose windows are [claimStart, allowlistStart),
 * [allowlistStart, publicStart), [publicStart, ∞), where any start getter
 * returning 0 means "unscheduled".
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { resolvePhaseState, type PhaseWindow } from "./mint-phases.ts"

// Helper: a claim → allowlist → public schedule with the conventional
// "endFn is the next phase's startFn" chaining already resolved to values.
function schedule(claim: bigint, allowlist: bigint, pub: bigint): PhaseWindow[] {
  return [
    { key: "claim", label: "Claim", start: claim.toString(), end: allowlist.toString() },
    { key: "allowlist", label: "Allowlist", start: allowlist.toString(), end: pub.toString() },
    { key: "public", label: "Public", start: pub.toString(), end: "0" },
  ]
}

const T0 = 1_700_000_000n // arbitrary base time

test("nothing scheduled: all starts 0 → no active, no next, not allEnded", () => {
  const s = resolvePhaseState(schedule(0n, 0n, 0n), Number(T0))
  assert.equal(s.activeIndex, -1)
  assert.equal(s.activeKey, null)
  assert.equal(s.nextIndex, -1)
  assert.equal(s.nextStart, 0n)
  assert.equal(s.anyScheduled, false)
  assert.equal(s.allEnded, false)
})

test("before the first phase: nothing active, claim is next", () => {
  const s = resolvePhaseState(schedule(T0, T0 + 100n, T0 + 200n), Number(T0 - 1n))
  assert.equal(s.activeIndex, -1)
  assert.equal(s.nextKey, "claim")
  assert.equal(s.nextStart, T0)
  assert.equal(s.anyScheduled, true)
  assert.equal(s.allEnded, false)
})

test("start boundary is inclusive: at exactly claimStart the claim phase is live", () => {
  const s = resolvePhaseState(schedule(T0, T0 + 100n, T0 + 200n), Number(T0))
  assert.equal(s.activeKey, "claim")
  assert.equal(s.nextKey, "allowlist")
  assert.equal(s.nextStart, T0 + 100n)
})

test("end boundary is exclusive: at exactly allowlistStart the claim phase has ended", () => {
  const s = resolvePhaseState(schedule(T0, T0 + 100n, T0 + 200n), Number(T0 + 100n))
  assert.equal(s.activeKey, "allowlist")
  assert.equal(s.nextKey, "public")
})

test("mid-window: one second before the handoff, the earlier phase still holds", () => {
  const s = resolvePhaseState(schedule(T0, T0 + 100n, T0 + 200n), Number(T0 + 99n))
  assert.equal(s.activeKey, "claim")
})

test("last phase is open-ended: active arbitrarily far in the future, nothing next", () => {
  const s = resolvePhaseState(schedule(T0, T0 + 100n, T0 + 200n), Number(T0 + 10_000_000n))
  assert.equal(s.activeKey, "public")
  assert.equal(s.nextIndex, -1)
  assert.equal(s.nextStart, 0n)
  assert.equal(s.allEnded, false) // open-ended ≠ ended
})

test("unscheduled middle phase (start 0) never activates; earlier phase stays open through its slot", () => {
  // Claim scheduled, allowlist NOT scheduled (0), public scheduled. The claim
  // window's end getter (allowlistStart) reads 0 → claim is open-ended until
  // ... it isn't: its end value is 0, so claim runs until public starts —
  // but resolution is per-window, and later phases supersede: once public
  // starts, both windows match and public (the later index) wins.
  const windows: PhaseWindow[] = [
    { key: "claim", label: "Claim", start: T0.toString(), end: "0" },
    { key: "allowlist", label: "Allowlist", start: "0", end: (T0 + 200n).toString() },
    { key: "public", label: "Public", start: (T0 + 200n).toString(), end: "0" },
  ]
  const during = resolvePhaseState(windows, Number(T0 + 50n))
  assert.equal(during.activeKey, "claim")
  assert.equal(during.nextKey, "public")

  const after = resolvePhaseState(windows, Number(T0 + 300n))
  assert.equal(after.activeKey, "public") // later phase supersedes the open-ended claim
})

test("closed schedule: a bounded last window that has passed → allEnded", () => {
  const windows: PhaseWindow[] = [
    { key: "only", label: "Only", start: T0.toString(), end: (T0 + 100n).toString() },
  ]
  const s = resolvePhaseState(windows, Number(T0 + 100n))
  assert.equal(s.activeIndex, -1)
  assert.equal(s.nextIndex, -1)
  assert.equal(s.anyScheduled, true)
  assert.equal(s.allEnded, true)
})

test("unknown clock (nowSec = 0): nothing active, everything scheduled reads as upcoming", () => {
  const s = resolvePhaseState(schedule(T0, T0 + 100n, T0 + 200n), 0)
  assert.equal(s.activeIndex, -1)
  assert.equal(s.nextKey, "claim")
  assert.equal(s.allEnded, false)
})

test("next is the EARLIEST future start even when declaration order differs", () => {
  const windows: PhaseWindow[] = [
    { key: "b", label: "B", start: (T0 + 500n).toString(), end: "0" },
    { key: "a", label: "A", start: (T0 + 100n).toString(), end: (T0 + 500n).toString() },
  ]
  const s = resolvePhaseState(windows, Number(T0))
  assert.equal(s.nextKey, "a")
  assert.equal(s.nextStart, T0 + 100n)
})

test("overlapping misconfigured windows: the later phase wins", () => {
  const windows: PhaseWindow[] = [
    { key: "first", label: "First", start: T0.toString(), end: "0" }, // open-ended
    { key: "second", label: "Second", start: (T0 + 10n).toString(), end: "0" }, // overlaps
  ]
  const s = resolvePhaseState(windows, Number(T0 + 20n))
  assert.equal(s.activeKey, "second")
})
