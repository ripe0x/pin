import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  ENQUEUE_SQL,
  LATEST_JOB_SQL,
  MARK_CACHE_INVALIDATED_SQL,
  cooldownDecision,
  cooldownMinutes,
  jobFromRow,
  needsCacheInvalidation,
  publicJob,
  type RefreshJob,
  type RefreshJobRow,
} from "./refresh-jobs-core.ts"

const flat = (s: string) => s.replace(/\s+/g, " ").trim()

const row = (over: Partial<RefreshJobRow> = {}): RefreshJobRow => ({
  id: 5,
  kind: "artist",
  target: "0x" + "a".repeat(40),
  status: "done",
  attempts: 1,
  max_attempts: 3,
  enqueued_at: "2026-11-04T00:00:00Z",
  started_at: "2026-11-04T00:00:05Z",
  finished_at: "2026-11-04T00:01:00Z",
  finished_age_seconds: 120,
  last_error: null,
  result: { known: true, added: 2, total: 50, failedSources: [] },
  cache_invalidated_at: null,
  ...over,
})

const job = (over: Partial<RefreshJobRow> = {}): RefreshJob => jobFromRow(row(over))

test("no previous job: allowed", () => {
  assert.deepEqual(cooldownDecision(null, 600), { allow: true })
})

test("an active job refuses a new one and hands back the active job", () => {
  for (const status of ["queued", "running"] as const) {
    const j = job({ status, finished_at: null, finished_age_seconds: null })
    const d = cooldownDecision(j, 600)
    assert.equal(d.allow, false)
    assert.equal(!d.allow && d.reason, "active")
    assert.equal(!d.allow && d.job.id, "5")
    assert.equal(!d.allow && d.retryAfter, 600)
  }
})

test("a job finished inside the cooldown refuses with the remaining seconds", () => {
  const d = cooldownDecision(job({ finished_age_seconds: 120 }), 600)
  assert.deepEqual(!d.allow && [d.reason, d.retryAfter], ["cooldown", 480])
  // Failed jobs cool down too (the worker already retried them).
  const f = cooldownDecision(job({ status: "failed", finished_age_seconds: 30 }), 120)
  assert.deepEqual(!f.allow && [f.reason, f.retryAfter], ["cooldown", 90])
})

test("a job finished past the cooldown allows a new one", () => {
  assert.deepEqual(cooldownDecision(job({ finished_age_seconds: 600 }), 600), { allow: true })
  assert.deepEqual(cooldownDecision(job({ finished_age_seconds: 5 }), 0), { allow: true })
})

test("token cooldown is shorter than the artist one by default", async () => {
  const core = await import("./refresh-jobs-core.ts")
  assert.ok(core.DEFAULT_TOKEN_COOLDOWN_MINUTES < core.DEFAULT_ARTIST_COOLDOWN_MINUTES)
  assert.equal(core.DEFAULT_ARTIST_COOLDOWN_MINUTES, 10)
})

test("cooldown minutes env parsing", () => {
  assert.equal(cooldownMinutes(undefined, 10), 10)
  assert.equal(cooldownMinutes("", 10), 10)
  assert.equal(cooldownMinutes("0", 10), 0)
  assert.equal(cooldownMinutes("3", 10), 3)
  assert.equal(cooldownMinutes("-1", 10), 10)
  assert.equal(cooldownMinutes("abc", 10), 10)
})

test("public job exposes counts, and the error only when failed", () => {
  const p = publicJob(job())
  assert.equal(p.added, 2)
  assert.equal(p.total, 50)
  assert.equal(p.error, null)
  assert.equal(publicJob(job({ status: "failed", last_error: "boom" })).error, "boom")
  assert.equal(publicJob(job({ status: "done", last_error: "earlier attempt" })).error, null)
  assert.equal(publicJob(job({ result: null })).added, null)
  assert.ok(!("target" in p))
})

test("only a done artist job not yet invalidated evicts the cache", () => {
  assert.equal(needsCacheInvalidation(job()), true)
  assert.equal(needsCacheInvalidation(job({ cache_invalidated_at: "2026-11-04T00:02:00Z" })), false)
  assert.equal(needsCacheInvalidation(job({ status: "failed" })), false)
  assert.equal(needsCacheInvalidation(job({ kind: "token", target: "0xabc:1" })), false)
})

test("enqueue matches the one-active-job index; reads are newest-first", () => {
  assert.match(flat(ENQUEUE_SQL), /ON CONFLICT \(kind, target\) WHERE status IN \('queued', 'running'\) DO NOTHING/)
  assert.match(flat(LATEST_JOB_SQL), /WHERE kind = \$1 AND target = \$2 ORDER BY id DESC LIMIT 1/)
  assert.match(flat(MARK_CACHE_INVALIDATED_SQL), /cache_invalidated_at IS NULL/)
})
