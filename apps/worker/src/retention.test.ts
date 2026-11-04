import { strict as assert } from "node:assert"
import { test } from "node:test"
import { RETENTION_STEPS, retentionDays } from "./retention.ts"
import { connectionParameters, statementTimeoutMs } from "./db-config.ts"

test("retention days default to 30", () => {
  assert.equal(retentionDays(undefined), 30)
  assert.equal(retentionDays("7"), 7)
  assert.equal(retentionDays("0"), 30)
  assert.equal(retentionDays("x"), 30)
})

test("every retention step is a bounded, batched DELETE", () => {
  const names = RETENTION_STEPS.map((s) => s.name)
  assert.deepEqual(names, ["cache_entries", "worker_iterations", "rate_limits", "scan_backoff"])
  for (const s of RETENTION_STEPS) {
    assert.match(s.sql, /^DELETE FROM \w+ WHERE .* IN \(SELECT .* LIMIT \$1::int\)$/)
    assert.ok(s.batchSize > 0 && s.maxBatches > 0)
    // Every placeholder the SQL uses is supplied ($1 = batch size).
    const used = new Set(Array.from(s.sql.matchAll(/\$(\d+)/g), (m) => Number(m[1])))
    assert.equal(used.size, 1 + s.params(30).length, s.name)
  }
})

test("cache_entries uses pgCacheCleanup's one-day grace", () => {
  const step = RETENTION_STEPS.find((s) => s.name === "cache_entries")!
  assert.match(step.sql, /expires_at < NOW\(\) - interval '1 day'/)
})

test("rate_limits (#369) is skipped when its table doesn't exist", () => {
  const step = RETENTION_STEPS.find((s) => s.name === "rate_limits")!
  assert.equal(step.requiresTable, "public.rate_limits")
})

test("worker statement_timeout defaults to 30s and is env-overridable", () => {
  assert.equal(statementTimeoutMs(undefined), 30_000)
  assert.equal(statementTimeoutMs("5000"), 5_000)
  assert.equal(statementTimeoutMs("0"), 0)
  assert.equal(statementTimeoutMs("-1"), 30_000)
  assert.deepEqual(connectionParameters(undefined), { application_name: "pnd-worker", statement_timeout: 30_000 })
  assert.deepEqual(connectionParameters("0"), { application_name: "pnd-worker" })
})
