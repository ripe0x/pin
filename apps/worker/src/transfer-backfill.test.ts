import { strict as assert } from "node:assert"
import { test } from "node:test"
import { planBackfill } from "./transfer-backfill.ts"

const row = (contract: string, tokenId: string, nextBlock: bigint) => ({ contract, tokenId, nextBlock })

test("tokens on a contract the forward scan hasn't started need no backfill", () => {
  const plan = planBackfill([row("0xa", "1", 100n)], {
    cursorByContract: new Map(),
    floorByContract: new Map(),
  })
  assert.deepEqual(plan.work, [])
  assert.deepEqual(plan.done, [{ contract: "0xa", tokenIds: ["1"] }])
})

test("tokens minted after the forward cursor are left to the forward scan", () => {
  const plan = planBackfill([row("0xa", "1", 600n)], {
    cursorByContract: new Map([["0xa", 500n]]),
    floorByContract: new Map(),
  })
  assert.deepEqual(plan.work, [])
  assert.deepEqual(plan.done, [{ contract: "0xa", tokenIds: ["1"] }])
})

test("late-discovered tokens are walked once per contract, from the earliest", () => {
  const plan = planBackfill(
    [row("0xb", "7", 300n), row("0xa", "1", 200n), row("0xa", "2", 100n), row("0xa", "3", 900n)],
    {
      cursorByContract: new Map([["0xa", 500n], ["0xb", 400n]]),
      floorByContract: new Map(),
    },
  )
  assert.deepEqual(plan.work, [
    { contract: "0xa", from: 100n, to: 500n, tokenIds: ["1", "2"] },
    { contract: "0xb", from: 300n, to: 400n, tokenIds: ["7"] },
  ])
  assert.deepEqual(plan.done, [{ contract: "0xa", tokenIds: ["3"] }])
})

test("an unknown (0) mint block is floored at the contract's lowest known mint", () => {
  const plan = planBackfill([row("0xa", "1", 0n), row("0xc", "9", 0n)], {
    cursorByContract: new Map([["0xa", 500n], ["0xc", 500n]]),
    floorByContract: new Map([["0xa", 250n]]),
  })
  assert.deepEqual(plan.work, [{ contract: "0xa", from: 250n, to: 500n, tokenIds: ["1"] }])
  // No positive mint block to bound the walk from: dropped, not a genesis walk.
  assert.deepEqual(plan.done, [{ contract: "0xc", tokenIds: ["9"] }])
})

test("resumed progress (next_block advanced) narrows the walk", () => {
  const plan = planBackfill([row("0xa", "1", 401n), row("0xa", "2", 401n)], {
    cursorByContract: new Map([["0xa", 500n]]),
    floorByContract: new Map(),
  })
  assert.deepEqual(plan.work, [{ contract: "0xa", from: 401n, to: 500n, tokenIds: ["1", "2"] }])
})
