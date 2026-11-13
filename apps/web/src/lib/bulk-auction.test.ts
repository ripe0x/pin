import { test } from "node:test"
import assert from "node:assert/strict"

import { batches, BULK_AUCTION_BATCH } from "./bulk-auction"

test("333 tokens split into 100 + 100 + 100 + 33, order kept", () => {
  const ids = Array.from({ length: 333 }, (_, i) => i + 1)
  const out = batches(ids)
  assert.deepEqual(out.map((b) => b.length), [100, 100, 100, 33])
  assert.deepEqual(out.flat(), ids)
  assert.equal(BULK_AUCTION_BATCH, 100)
})

test("small and empty selections", () => {
  assert.deepEqual(batches([1, 2, 3]), [[1, 2, 3]])
  assert.deepEqual(batches([]), [])
})
