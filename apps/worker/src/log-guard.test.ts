import { strict as assert } from "node:assert"
import { test } from "node:test"
import { InvalidLogError, PLACEHOLDER_LOG_INDEX, assertLogsInRange, isValidLogIndex } from "./log-guard.ts"

const log = (blockNumber: bigint | null, logIndex: number | null, tx: string | null = "0xabc") =>
  ({ blockNumber, logIndex, transactionHash: tx })

test("valid log indexes", () => {
  assert.ok(isValidLogIndex(0))
  assert.ok(isValidLogIndex(1234))
  assert.ok(!isValidLogIndex(PLACEHOLDER_LOG_INDEX))
  assert.ok(!isValidLogIndex(-1))
  assert.ok(!isValidLogIndex(1.5))
  assert.ok(!isValidLogIndex(Number.NaN))
  assert.ok(!isValidLogIndex(Number.POSITIVE_INFINITY))
  assert.ok(!isValidLogIndex(null))
})

test("in-range mined logs pass through", () => {
  const logs = [log(10n, 0), log(20n, 5)]
  assert.equal(assertLogsInRange(logs, 10n, 20n), logs)
  assert.deepEqual(assertLogsInRange([], 10n, 20n), [])
})

test("a log outside the requested range fails the fetch", () => {
  assert.throws(() => assertLogsInRange([log(21n, 0)], 10n, 20n), InvalidLogError)
  assert.throws(() => assertLogsInRange([log(9n, 0)], 10n, 20n), /outside the requested range/)
})

test("pending logs and placeholder indexes fail the fetch", () => {
  assert.throws(() => assertLogsInRange([log(null, 0)], 10n, 20n), /pending/)
  assert.throws(() => assertLogsInRange([log(15n, PLACEHOLDER_LOG_INDEX)], 10n, 20n), /invalid log index 4294967295/)
  assert.throws(() => assertLogsInRange([log(15n, null)], 10n, 20n), /invalid log index/)
  assert.throws(() => assertLogsInRange([log(15n, 1, null)], 10n, 20n), /no tx hash/)
})
