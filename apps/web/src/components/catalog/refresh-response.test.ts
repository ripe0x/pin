import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  POLL_DELAYS_MS,
  applyStatusPoll,
  describeJob,
  refreshStateFromResponse,
  shouldPoll,
  type RefreshState,
} from "./refresh-response.ts"

const job = (over: Record<string, unknown> = {}) => ({
  id: "12",
  status: "queued",
  attempts: 0,
  maxAttempts: 3,
  added: null,
  total: null,
  failedSources: [],
  error: null,
  ...over,
})

test("202 with a durable job follows that job", () => {
  assert.deepEqual(
    refreshStateFromResponse(202, { ok: true, enqueued: true, job: job() }),
    {
      kind: "job",
      alreadyQueued: false,
      job: { id: "12", status: "queued", added: null, failedSources: [], error: null },
    },
  )
})

test("429 reason=active follows the existing job instead of a dead end", () => {
  const s = refreshStateFromResponse(429, {
    ok: false, reason: "active", retryAfter: 600, job: job({ status: "running" }),
  })
  assert.equal(s.kind, "job")
  assert.equal(s.kind === "job" && s.alreadyQueued, true)
  assert.equal(s.kind === "job" && s.job.status, "running")
})

test("429 reason=cooldown is rate-limited with the server's retryAfter", () => {
  assert.deepEqual(
    refreshStateFromResponse(429, { ok: false, reason: "cooldown", retryAfter: 420, job: job({ status: "done" }) }),
    { kind: "rate-limited", retryAfterSec: 420 },
  )
})

test("status polls advance the followed job to a terminal state", () => {
  let s: RefreshState = refreshStateFromResponse(202, { ok: true, enqueued: true, job: job() })
  s = applyStatusPoll(s, 200, { ok: true, job: job({ status: "running" }) })
  assert.equal(s.kind === "job" && s.job.status, "running")
  assert.equal(shouldPoll(s, 1), true)
  s = applyStatusPoll(s, 200, { ok: true, job: job({ status: "done", added: 3, total: 40 }) })
  assert.equal(s.kind === "job" && s.job.status, "done")
  assert.equal(shouldPoll(s, 2), false, "terminal: stop polling")
  assert.equal(s.kind === "job" && describeJob(s.job), "Refresh done — 3 new pieces")
})

test("polls that fail, or report a different job, leave the state alone", () => {
  const s = refreshStateFromResponse(202, { ok: true, enqueued: true, job: job() })
  assert.equal(applyStatusPoll(s, 503, { ok: false }), s)
  assert.equal(applyStatusPoll(s, 200, { ok: true, job: null }), s)
  assert.equal(applyStatusPoll(s, 200, { ok: true, job: job({ id: "13", status: "done" }) }), s)
  assert.equal(applyStatusPoll({ kind: "idle" }, 200, { ok: true, job: job() }).kind, "idle")
})

test("polling stops after the backoff schedule runs out", () => {
  const s = refreshStateFromResponse(202, { ok: true, enqueued: true, job: job() })
  assert.equal(shouldPoll(s, 0), true)
  assert.equal(shouldPoll(s, POLL_DELAYS_MS.length - 1), true)
  assert.equal(shouldPoll(s, POLL_DELAYS_MS.length), false)
  for (let i = 1; i < POLL_DELAYS_MS.length; i++) {
    assert.ok(POLL_DELAYS_MS[i] >= POLL_DELAYS_MS[i - 1], "delays never shrink")
  }
})

test("job descriptions", () => {
  const view = (o: Record<string, unknown>) => {
    const s = refreshStateFromResponse(202, { ok: true, job: job(o) })
    if (s.kind !== "job") throw new Error("expected a job")
    return s.job
  }
  assert.equal(describeJob(view({ status: "queued" })), "Refresh queued")
  assert.equal(describeJob(view({ status: "queued" }), true), "A refresh is already queued")
  assert.equal(describeJob(view({ status: "done", added: 0 })), "Refresh done — no new pieces")
  assert.equal(describeJob(view({ status: "done", added: 1 })), "Refresh done — 1 new piece")
  assert.equal(
    describeJob(view({ status: "done", added: 2, failedSources: ["manifold"] })),
    "Refresh done — 2 new pieces (some sources didn’t finish: manifold)",
  )
  assert.equal(describeJob(view({ status: "failed", error: "rpc down" })), "Refresh failed: rpc down")
})

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
