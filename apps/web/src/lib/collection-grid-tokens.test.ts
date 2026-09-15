import { test } from "node:test"
import assert from "node:assert/strict"
import { selectGridTokenIds } from "./collection-grid-tokens.ts"

test("selectGridTokenIds: indexer ids win and are capped", () => {
  assert.deepEqual(selectGridTokenIds([9, 7, 5, 3], 4n), [9, 7, 5, 3])
  assert.deepEqual(selectGridTokenIds([9, 7, 5, 3], 4n, 2), [9, 7])
})

test("selectGridTokenIds: no indexer rows falls back to a sequential range", () => {
  assert.deepEqual(selectGridTokenIds([], 2n), [1, 2])
  assert.deepEqual(selectGridTokenIds([], 1n), [1])
})

test("selectGridTokenIds: the fallback range is capped", () => {
  assert.deepEqual(selectGridTokenIds([], 20n, 12), Array.from({ length: 12 }, (_, i) => i + 1))
})

test("selectGridTokenIds: nothing minted shows nothing", () => {
  assert.deepEqual(selectGridTokenIds([], 0n), [])
})
