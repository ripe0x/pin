import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  CLAIM_SQL, COMPLETE_SQL, ENQUEUE_SQL, FAIL_SQL, HEARTBEAT_SQL, RECLAIM_SQL, RELEASE_SQL,
  afterFailure, artistTarget, isClaimable, isLeaseExpired, parseTokenTarget,
  positiveIntEnv, retryDelaySeconds, runNextRefreshJob, tokenTarget, truncateError,
} from "./refresh-queue.ts"

const flat = (s: string) => s.replace(/\s+/g, " ").trim()

test("retry delay grows 4x per attempt from 30s and caps at 30 min", () => {
  assert.equal(retryDelaySeconds(0), 0)
  assert.equal(retryDelaySeconds(1), 30)
  assert.equal(retryDelaySeconds(2), 120)
  assert.equal(retryDelaySeconds(3), 480)
  assert.equal(retryDelaySeconds(4), 1800)
  assert.equal(retryDelaySeconds(1_000), 1800)
})

test("a failed attempt retries until max_attempts, then fails for good", () => {
  const now = new Date(1_000_000)
  const first = afterFailure({ attempts: 1, maxAttempts: 3 }, now)
  assert.equal(first.status, "queued")
  assert.equal(first.status === "queued" && first.runAfter.getTime(), 1_000_000 + 30_000)
  const second = afterFailure({ attempts: 2, maxAttempts: 3 }, now)
  assert.equal(second.status === "queued" && second.runAfter.getTime(), 1_000_000 + 120_000)
  assert.deepEqual(afterFailure({ attempts: 3, maxAttempts: 3 }, now), { status: "failed", finishedAt: now })
  // Reclaim retries immediately (delay 0) but still counts the attempt.
  const reclaimed = afterFailure({ attempts: 1, maxAttempts: 3 }, now, 0)
  assert.equal(reclaimed.status === "queued" && reclaimed.runAfter.getTime(), now.getTime())
})

test("a whole job lifecycle: retry backoff gates the next claim", () => {
  // Simulate the state machine the SQL implements, one clock tick at a time.
  let job = { status: "queued" as "queued" | "running" | "done" | "failed", attempts: 0, maxAttempts: 3, runAfter: new Date(0) }
  const claims: number[] = []
  for (let t = 0; t < 2_000; t++) {
    const now = new Date(t * 1000)
    if (!isClaimable(job, now)) continue
    claims.push(t)
    job = { ...job, status: "running", attempts: job.attempts + 1 }
    const next = afterFailure(job, now) // every attempt fails
    job = next.status === "queued"
      ? { ...job, status: "queued", runAfter: next.runAfter }
      : { ...job, status: "failed" }
  }
  assert.deepEqual(claims, [0, 30, 150])
  assert.equal(job.status, "failed")
})

test("lease expiry", () => {
  const now = new Date(10 * 60_000)
  assert.equal(isLeaseExpired(null, now), true)
  assert.equal(isLeaseExpired(new Date(now.getTime() - 299_000), now), false)
  assert.equal(isLeaseExpired(new Date(now.getTime() - 301_000), now), true)
  assert.equal(isLeaseExpired(new Date(now.getTime() - 61_000), now, 60), true)
})

test("targets are normalized and validated", () => {
  assert.equal(artistTarget("0xABCDEF0123456789abcdef0123456789ABCDEF01"), "0xabcdef0123456789abcdef0123456789abcdef01")
  assert.equal(artistTarget("0x123"), null)
  assert.equal(tokenTarget("0xABCDEF0123456789abcdef0123456789ABCDEF01", "42"), "0xabcdef0123456789abcdef0123456789abcdef01:42")
  assert.equal(tokenTarget("0xabcdef0123456789abcdef0123456789abcdef01", "-1"), null)
  assert.deepEqual(parseTokenTarget("0xabc:7"), { contract: "0xabc", tokenId: "7" })
})

test("env ints and error truncation", () => {
  assert.equal(positiveIntEnv(undefined, 5), 5)
  assert.equal(positiveIntEnv("0", 5), 5)
  assert.equal(positiveIntEnv("12", 5), 12)
  assert.equal(truncateError("x".repeat(5_000)).length, 1_000)
})

test("enqueue relies on the one-active-job partial unique index", () => {
  assert.match(flat(ENQUEUE_SQL), /ON CONFLICT \(kind, target\) WHERE status IN \('queued', 'running'\) DO NOTHING/)
})

test("claim takes the oldest due queued job with SKIP LOCKED and counts the attempt", () => {
  const q = flat(CLAIM_SQL)
  assert.match(q, /WHERE kind = \$1 AND status = 'queued' AND run_after <= NOW\(\)/)
  assert.match(q, /ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED/)
  assert.match(q, /SET status = 'running', attempts = attempts \+ 1/)
})

test("writes after the claim are fenced on the claimed attempt", () => {
  for (const q of [HEARTBEAT_SQL, COMPLETE_SQL, FAIL_SQL, RELEASE_SQL]) {
    assert.match(flat(q), /WHERE id = \$1::bigint AND status = 'running' AND attempts = \$2::int/)
  }
})

test("fail and reclaim share the retry-or-fail rule", () => {
  for (const q of [FAIL_SQL, RECLAIM_SQL]) {
    const f = flat(q)
    assert.match(f, /status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END/)
    assert.match(f, /finished_at = CASE WHEN attempts >= max_attempts THEN NOW\(\) ELSE NULL END/)
  }
  assert.match(flat(FAIL_SQL), /run_after = NOW\(\) \+ \(\$4::int \* interval '1 second'\)/)
  assert.match(flat(RECLAIM_SQL), /heartbeat_at < NOW\(\) - \(\$1::int \* interval '1 second'\)/)
  // Release hands the attempt back.
  assert.match(flat(RELEASE_SQL), /attempts = GREATEST\(attempts - 1, 0\)/)
})

function fakeSql(responses: Array<unknown[]>) {
  const queries: Array<{ q: string; params: Array<string | number> }> = []
  return {
    queries,
    sql: {
      unsafe: async (q: string, params: Array<string | number> = []) => {
        queries.push({ q, params })
        return responses.shift() ?? []
      },
    },
  }
}

const claimed = { id: "7", kind: "artist", target: "0xabc", attempts: 1, max_attempts: 3 }

test("runNextRefreshJob: idle when nothing is due", async () => {
  const { sql, queries } = fakeSql([[]])
  const out = await runNextRefreshJob(sql, "artist", async () => ({}), { timeoutMs: 1000 })
  assert.deepEqual(out, { kind: "idle" })
  assert.equal(queries.length, 1)
})

test("runNextRefreshJob: success stores the handler's result", async () => {
  const { sql, queries } = fakeSql([[claimed], [{ id: "7" }]])
  const out = await runNextRefreshJob(sql, "artist", async (t) => ({ target: t, added: 2 }), { timeoutMs: 1000 })
  assert.equal(out.kind, "done")
  assert.equal(queries[1].q, COMPLETE_SQL)
  assert.deepEqual(queries[1].params, ["7", 1, JSON.stringify({ target: "0xabc", added: 2 })])
})

test("runNextRefreshJob: a throw records a retry with backoff", async () => {
  const { sql, queries } = fakeSql([[claimed], [{ status: "queued" }]])
  const out = await runNextRefreshJob(sql, "artist", async () => { throw new Error("rpc down") }, { timeoutMs: 1000 })
  assert.deepEqual(out.kind, "retry")
  assert.equal(queries[1].q, FAIL_SQL)
  assert.deepEqual(queries[1].params, ["7", 1, "rpc down", 30])
})

test("runNextRefreshJob: the last attempt fails the job", async () => {
  const { sql } = fakeSql([[{ ...claimed, attempts: 3 }], [{ status: "failed" }]])
  const out = await runNextRefreshJob(sql, "artist", async () => { throw new Error("x") }, { timeoutMs: 1000 })
  assert.equal(out.kind, "failed")
})

test("runNextRefreshJob: a hung handler times out as a failed attempt", async () => {
  const { sql, queries } = fakeSql([[claimed], [{ status: "queued" }]])
  const out = await runNextRefreshJob(sql, "artist", () => new Promise(() => {}), { timeoutMs: 20 })
  assert.equal(out.kind, "retry")
  assert.match(String(queries[1].params[2]), /timed out/)
})

test("runNextRefreshJob: a reclaimed lease reports lost, not done", async () => {
  const { sql } = fakeSql([[claimed], []])
  const out = await runNextRefreshJob(sql, "artist", async () => ({}), { timeoutMs: 1000 })
  assert.equal(out.kind, "lost")
})

test("runNextRefreshJob heartbeats while the handler runs", async () => {
  const { sql, queries } = fakeSql([[claimed], [], [], [], [{ id: "7" }]])
  await runNextRefreshJob(
    sql, "artist",
    () => new Promise((resolve) => setTimeout(() => resolve({}), 60)),
    { timeoutMs: 1000, heartbeatMs: 15 },
  )
  assert.ok(queries.some((q) => q.q === HEARTBEAT_SQL), "at least one heartbeat")
})
