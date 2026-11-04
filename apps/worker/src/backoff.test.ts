import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  backoffDelayMs, isBackedOff, nextBackoff, toPgTextArray, withBackoff,
  type BackoffRow,
} from "./backoff.ts"

const MIN = 60_000
const policy = { baseMs: 10 * MIN, maxMs: 24 * 60 * MIN }

test("delay doubles per failure from 2x base and is capped", () => {
  assert.equal(backoffDelayMs(0, policy), 0)
  assert.equal(backoffDelayMs(1, policy), 20 * MIN)
  assert.equal(backoffDelayMs(2, policy), 40 * MIN)
  assert.equal(backoffDelayMs(3, policy), 80 * MIN)
  assert.equal(backoffDelayMs(10, policy), 24 * 60 * MIN)
  assert.equal(backoffDelayMs(10_000, policy), 24 * 60 * MIN)
  // A zero policy records the failure without skipping any ticks.
  assert.equal(backoffDelayMs(5, { baseMs: 0, maxMs: 0 }), 0)
})

test("a scope failing every retry never fails on consecutive ticks", () => {
  // Ticks every 10 min; record which ticks actually run the scope.
  const interval = 10 * MIN
  let row: BackoffRow | undefined
  const ran: number[] = []
  for (let tick = 0; tick < 40; tick++) {
    const now = new Date(tick * interval)
    if (isBackedOff(row, now)) continue
    ran.push(tick)
    row = nextBackoff(row, "s", "boom", now, policy)
  }
  assert.deepEqual(ran.slice(0, 5), [0, 2, 6, 14, 30])
  for (let i = 1; i < ran.length; i++) assert.ok(ran[i] - ran[i - 1] > 1)
})

test("nextBackoff increments failures and truncates long errors", () => {
  const now = new Date(0)
  const first = nextBackoff(undefined, "s", "x".repeat(5_000), now, policy)
  assert.equal(first.failures, 1)
  assert.equal(first.retryAt.getTime(), 20 * MIN)
  assert.equal(first.lastError!.length, 1_000)
  const second = nextBackoff(first, "s", "y", now, policy)
  assert.equal(second.failures, 2)
  assert.equal(second.retryAt.getTime(), 40 * MIN)
})

test("toPgTextArray quotes and escapes", () => {
  assert.equal(toPgTextArray([]), "{}")
  assert.equal(toPgTextArray(["0xa", "0xb"]), '{"0xa","0xb"}')
  assert.equal(toPgTextArray(['a"b', "c\\d"]), '{"a\\"b","c\\\\d"}')
})

function fakeSql() {
  const queries: Array<{ q: string; params: string[] }> = []
  return { queries, sql: { unsafe: async (q: string, params: string[] = []) => { queries.push({ q, params }); return [] } } }
}

test("withBackoff skips a backed-off scope without running it", async () => {
  const { sql, queries } = fakeSql()
  const now = new Date(1_000)
  const rows = new Map([["s", { scope: "s", failures: 1, retryAt: new Date(2_000), lastError: "x" }]])
  let ran = false
  const r = await withBackoff(sql, "t", "s", { rows, policy, now }, async () => { ran = true; return { error: null } })
  assert.deepEqual(r, { skipped: true })
  assert.equal(ran, false)
  assert.equal(queries.length, 0)
})

test("withBackoff records a failure and clears on recovery", async () => {
  const { sql, queries } = fakeSql()
  const now = new Date(5_000)
  const r1 = await withBackoff(sql, "t", "s", { rows: new Map(), policy, now }, async () => ({ error: "boom" }))
  assert.deepEqual(r1, { error: "boom" })
  assert.match(queries[0].q, /INSERT INTO scan_backoff/)
  assert.deepEqual(queries[0].params.slice(0, 3), ["t", "s", "1"])

  const rows = new Map([["s", { scope: "s", failures: 1, retryAt: new Date(0), lastError: "boom" }]])
  await withBackoff(sql, "t", "s", { rows, policy, now }, async () => ({ error: null }))
  assert.match(queries[1].q, /DELETE FROM scan_backoff/)
  assert.deepEqual(queries[1].params, ["t", '{"s"}'])
})

test("withBackoff without a context (on-demand refresh) never touches the table", async () => {
  const { sql, queries } = fakeSql()
  await withBackoff(sql, "refresh-artist", "s", undefined, async () => ({ error: "boom" }))
  assert.equal(queries.length, 0)
})
