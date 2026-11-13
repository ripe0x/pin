import { test } from "node:test"
import assert from "node:assert/strict"

import { batches, BULK_AUCTION_BATCH } from "./bulk-auction"

test("333 tokens split into 70 x 4 + 53, order kept", () => {
  const ids = Array.from({ length: 333 }, (_, i) => i + 1)
  const out = batches(ids)
  assert.deepEqual(out.map((b) => b.length), [70, 70, 70, 70, 53])
  assert.deepEqual(out.flat(), ids)
  assert.equal(BULK_AUCTION_BATCH, 70)
})

test("one batch stays under the 2^24 per-transaction gas cap", () => {
  assert.ok(BULK_AUCTION_BATCH * 204_000 + 1_000_000 < 16_777_216)
})

test("small and empty selections", () => {
  assert.deepEqual(batches([1, 2, 3]), [[1, 2, 3]])
  assert.deepEqual(batches([]), [])
})
