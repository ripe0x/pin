import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  checkSharedLimit,
  createMemoryLimiter,
  getClientIp,
  type SharedCounterStore,
} from "./rate-limit-core.ts"

function req(headers: Record<string, string>) {
  return { headers: new Headers(headers) }
}

test("client IP prefers Netlify's connection IP over forwarded headers", () => {
  assert.equal(
    getClientIp(
      req({
        "x-nf-client-connection-ip": "203.0.113.9",
        "x-real-ip": "198.51.100.1",
        "x-forwarded-for": "1.2.3.4, 203.0.113.9",
      }),
    ),
    "203.0.113.9",
  )
})

test("client IP falls back to x-real-ip, then the first x-forwarded-for entry", () => {
  assert.equal(
    getClientIp(req({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "1.2.3.4" })),
    "198.51.100.1",
  )
  assert.equal(getClientIp(req({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" })), "1.2.3.4")
  assert.equal(getClientIp(req({})), "unknown")
  assert.equal(getClientIp(req({ "x-nf-client-connection-ip": "  " , "x-real-ip": "9.9.9.9" })), "9.9.9.9")
})

test("memory limiter blocks past the window budget and resets after it", () => {
  const l = createMemoryLimiter()
  const t0 = 1_000_000
  assert.deepEqual(l.check("a", 60_000, 2, 1, t0), { ok: true })
  assert.deepEqual(l.check("a", 60_000, 2, 1, t0 + 1), { ok: true })
  const blocked = l.check("a", 60_000, 2, 1, t0 + 2)
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.equal(blocked.retryAfter, 60)
  // Independent key.
  assert.deepEqual(l.check("b", 60_000, 2, 1, t0 + 2), { ok: true })
  // New window.
  assert.deepEqual(l.check("a", 60_000, 2, 1, t0 + 60_001), { ok: true })
})

test("memory limiter charges batch cost", () => {
  const l = createMemoryLimiter()
  assert.deepEqual(l.check("a", 60_000, 10, 8, 0), { ok: true })
  assert.equal(l.check("a", 60_000, 10, 3, 1).ok, false)
  assert.deepEqual(l.check("a", 60_000, 10, 2, 2), { ok: true })
  assert.equal(l.check("fresh", 60_000, 10, 11, 0).ok, false)
})

test("shared limit allows within budget and blocks past it", async () => {
  const windowStart = new Date(1_000_000)
  let count = 0
  const store: SharedCounterStore = async (_k, _w, cost) => {
    count += cost
    return { count, windowStart }
  }
  assert.deepEqual(await checkSharedLimit(store, "k", 60_000, 2, 1, { now: 1_000_100 }), { ok: true })
  assert.deepEqual(await checkSharedLimit(store, "k", 60_000, 2, 1, { now: 1_000_100 }), { ok: true })
  const blocked = await checkSharedLimit(store, "k", 60_000, 2, 1, { now: 1_030_000 })
  assert.deepEqual(blocked, { ok: false, retryAfter: 30 })
})

test("shared limit fails open on store errors, timeouts, and a missing store", async () => {
  const throwing: SharedCounterStore = async () => {
    throw new Error("relation \"rate_limits\" does not exist")
  }
  assert.deepEqual(await checkSharedLimit(throwing, "k", 60_000, 1), { ok: true })
  const hanging: SharedCounterStore = () => new Promise(() => {})
  assert.deepEqual(await checkSharedLimit(hanging, "k", 60_000, 1, 1, { timeoutMs: 20 }), { ok: true })
  assert.deepEqual(await checkSharedLimit(null, "k", 60_000, 1), { ok: true })
})
