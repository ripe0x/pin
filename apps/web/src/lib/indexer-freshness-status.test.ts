import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  STALE_THRESHOLD_SEC,
  freshnessHttpStatus,
  isFreshnessStale,
} from "./indexer-freshness-status.ts"

test("fresh data (well under threshold) is not stale", () => {
  assert.equal(isFreshnessStale(0), false)
  assert.equal(isFreshnessStale(60), false)
})

test("exactly at the threshold is not yet stale", () => {
  assert.equal(isFreshnessStale(STALE_THRESHOLD_SEC), false)
})

test("one second past the threshold is stale", () => {
  assert.equal(isFreshnessStale(STALE_THRESHOLD_SEC + 1), true)
})

test("route returns 200 for fresh data", () => {
  assert.equal(freshnessHttpStatus(0), 200)
  assert.equal(freshnessHttpStatus(STALE_THRESHOLD_SEC), 200)
})

test("route returns 503 for stale data", () => {
  assert.equal(freshnessHttpStatus(STALE_THRESHOLD_SEC + 1), 503)
})

test("route returns 503 when freshness could not be read at all", () => {
  assert.equal(freshnessHttpStatus(null), 503)
})
