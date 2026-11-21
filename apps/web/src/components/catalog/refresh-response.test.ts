import { strict as assert } from "node:assert"
import { test } from "node:test"
import { refreshStateFromResponse } from "./refresh-response.ts"

test("202 enqueued is a queued state, not a crash on missing counts (#297)", () => {
  assert.deepEqual(
    refreshStateFromResponse(202, { ok: true, enqueued: true }),
    { kind: "queued", alreadyQueued: false },
  )
})

test("202 enqueued:false (worker dedup) says a refresh is already running", () => {
  assert.deepEqual(
    refreshStateFromResponse(202, { ok: true, enqueued: false }),
    { kind: "queued", alreadyQueued: true },
  )
})

test("429 uses retryAfter, defaulting to 5 minutes", () => {
  assert.deepEqual(
    refreshStateFromResponse(429, { ok: false, error: "rate limited", retryAfter: 120 }),
    { kind: "rate-limited", retryAfterSec: 120 },
  )
  assert.deepEqual(
    refreshStateFromResponse(429, { ok: false, error: "rate limited" }),
    { kind: "rate-limited", retryAfterSec: 300 },
  )
})

test("403 and 503 surface the route's error text", () => {
  assert.deepEqual(
    refreshStateFromResponse(403, { ok: false, error: "unknown artist" }),
    { kind: "error", message: "unknown artist" },
  )
  assert.deepEqual(
    refreshStateFromResponse(503, { ok: false, error: "worker unavailable" }),
    { kind: "error", message: "worker unavailable" },
  )
})

test("an unparseable or empty body falls back to a generic error", () => {
  assert.deepEqual(refreshStateFromResponse(500, null), { kind: "error", message: "Refresh failed" })
  assert.deepEqual(refreshStateFromResponse(502, "<html>"), { kind: "error", message: "Refresh failed" })
  // A 2xx without ok:true is not a success.
  assert.deepEqual(refreshStateFromResponse(200, {}), { kind: "error", message: "Refresh failed" })
})
