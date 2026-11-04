import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  defaultTaskTimeoutMs, evaluateHealth, evaluateTaskHealth, maxConsecutiveFailures,
  type TaskHealthInput,
} from "./task-health.ts"

const MIN = 60_000
const boot = new Date(0)
const at = (ms: number) => new Date(ms)

function task(over: Partial<TaskHealthInput> = {}): TaskHealthInput {
  return {
    name: "scan-x",
    intervalMs: 10 * MIN,
    timeoutMs: defaultTaskTimeoutMs(10 * MIN),
    running: false,
    runningSince: null,
    lastFinishedAt: null,
    lastOkAt: null,
    lastSkippedAt: null,
    consecutiveFailures: 0,
    lastError: null,
    ...over,
  }
}

test("defaults", () => {
  assert.equal(defaultTaskTimeoutMs(5 * MIN), 120 * MIN)
  assert.equal(defaultTaskTimeoutMs(60 * MIN), 360 * MIN)
  assert.equal(maxConsecutiveFailures(undefined), 3)
  assert.equal(maxConsecutiveFailures("5"), 5)
  assert.equal(maxConsecutiveFailures("0"), 3)
})

test("a fresh boot is healthy before any task has run", () => {
  const r = evaluateHealth([task(), task({ name: "b" })], at(1 * MIN), boot)
  assert.equal(r.ok, true)
  assert.deepEqual(r.unhealthy, [])
})

test("N consecutive failures fail health; fewer don't", () => {
  const now = at(15 * MIN)
  const recent = { lastFinishedAt: at(14 * MIN) }
  assert.equal(evaluateTaskHealth(task({ ...recent, consecutiveFailures: 2 }), now, boot).status, "ok")
  const h = evaluateTaskHealth(task({ ...recent, consecutiveFailures: 3, lastError: "boom" }), now, boot)
  assert.equal(h.status, "failing")
  assert.equal(h.healthy, false)
  assert.equal(h.lastError, "boom")
  assert.equal(
    evaluateTaskHealth(task({ ...recent, consecutiveFailures: 3 }), now, boot, { maxConsecutiveFailures: 5 }).status,
    "ok",
  )
})

test("a run past its timeout is stuck", () => {
  const h = evaluateTaskHealth(
    task({ running: true, runningSince: at(0), timeoutMs: 30 * MIN }),
    at(31 * MIN), boot,
  )
  assert.equal(h.status, "stuck")
  assert.equal(h.runningForMs, 31 * MIN)
  // A long run inside its timeout is fine, and not "stale".
  assert.equal(
    evaluateTaskHealth(task({ running: true, runningSince: at(0), timeoutMs: 60 * MIN }), at(45 * MIN), boot).status,
    "ok",
  )
})

test("no finished run within 3x the interval is stale", () => {
  assert.equal(evaluateTaskHealth(task({ lastFinishedAt: at(0) }), at(30 * MIN), boot).status, "ok")
  assert.equal(evaluateTaskHealth(task({ lastFinishedAt: at(0) }), at(31 * MIN), boot).status, "stale")
  // Never ran since boot 31 min ago: stale too.
  assert.equal(evaluateTaskHealth(task(), at(31 * MIN), boot).status, "stale")
})

test("waiting on Ponder counts as alive and is reported", () => {
  const h = evaluateTaskHealth(task({ lastSkippedAt: at(40 * MIN) }), at(45 * MIN), boot)
  assert.equal(h.status, "waiting-on-ponder")
  assert.equal(h.healthy, true)
})

test("the report lists every unhealthy task and stays informative", () => {
  const r = evaluateHealth(
    [
      task({ name: "good", lastFinishedAt: at(59 * MIN), lastOkAt: at(59 * MIN) }),
      task({ name: "bad", lastFinishedAt: at(59 * MIN), consecutiveFailures: 4, lastError: "x".repeat(1_000) }),
    ],
    at(60 * MIN), boot,
  )
  assert.equal(r.ok, false)
  assert.deepEqual(r.unhealthy, ["bad"])
  assert.equal(r.tasks.good.lastOkAt, at(59 * MIN).toISOString())
  assert.equal(r.tasks.bad.lastError!.length, 300)
})
