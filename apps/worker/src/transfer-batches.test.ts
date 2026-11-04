import { strict as assert } from "node:assert"
import { test } from "node:test"
import { memberCursorUpdates, ownsLog, planTransferBatches, type TransferScope } from "./transfer-batches.ts"

const now = new Date(1_000_000)
const scope = (contract: string, from: bigint, failures = 0, retryAt = 0): TransferScope => ({
  contract,
  from,
  backoff: failures > 0
    ? { scope: contract, failures, retryAt: new Date(retryAt), lastError: "x" }
    : undefined,
})

test("caught-up contracts share one call per 50 addresses", () => {
  const scopes = Array.from({ length: 120 }, (_, i) => scope(`0x${String(i).padStart(3, "0")}`, 1_000n))
  const plan = planTransferBatches(scopes, { now, maxSpan: 9_500n })
  assert.deepEqual(plan.batches.map((b) => b.members.length), [50, 50, 20])
  assert.ok(plan.batches.every((b) => b.from === 1_000n && !b.solo))
  assert.deepEqual(plan.deferred, [])
})

test("contracts are bucketed by cursor span, sorted by from", () => {
  const plan = planTransferBatches(
    [scope("0xc", 50_000n), scope("0xa", 1_000n), scope("0xb", 5_000n), scope("0xd", 59_500n)],
    { now, maxSpan: 9_500n, maxAddresses: 50 },
  )
  assert.deepEqual(
    plan.batches.map((b) => ({ from: b.from, members: b.members.map((m) => m.contract) })),
    [
      { from: 1_000n, members: ["0xa", "0xb"] },
      { from: 50_000n, members: ["0xc", "0xd"] },
    ],
  )
})

test("one prior group failure still batches; isolateAfter failures goes solo", () => {
  const plan = planTransferBatches(
    [scope("0xa", 100n, 1), scope("0xb", 100n), scope("0xc", 100n, 2, 0)],
    { now, maxSpan: 9_500n },
  )
  assert.deepEqual(plan.batches.map((b) => [b.solo, b.members.map((m) => m.contract)]), [
    [false, ["0xa", "0xb"]],
    [true, ["0xc"]],
  ])
})

test("an isolated contract inside its retry delay is deferred", () => {
  const plan = planTransferBatches(
    [scope("0xa", 100n, 3, now.getTime() + 60_000), scope("0xb", 100n)],
    { now, maxSpan: 9_500n },
  )
  assert.deepEqual(plan.deferred, ["0xa"])
  assert.deepEqual(plan.batches.map((b) => b.members.map((m) => m.contract)), [["0xb"]])
})

test("cursor updates only for members the group actually reached", () => {
  const members = [
    { contract: "0xa", from: 1_000n },
    { contract: "0xb", from: 5_000n },
    { contract: "0xc", from: 9_000n },
  ]
  // Group stopped at 6,000 (failure or budget): 0xc keeps its cursor.
  assert.deepEqual(memberCursorUpdates(members, 6_000n), ["0xa", "0xb"])
  assert.deepEqual(memberCursorUpdates(members, 999n), [])
  assert.deepEqual(memberCursorUpdates(members, 20_000n), ["0xa", "0xb", "0xc"])
})

test("a member only owns logs at or above its own from", () => {
  assert.equal(ownsLog(5_000n, 4_999n), false)
  assert.equal(ownsLog(5_000n, 5_000n), true)
  assert.equal(ownsLog(5_000n, 9_000n), true)
})
