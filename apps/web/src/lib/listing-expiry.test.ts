import { strict as assert } from "node:assert"
import { test } from "node:test"
import { parseListingExpiry } from "./listing-expiry.ts"

const NOW = 1_800_000_000 // fixed reference point, well past any real block time we test against

test("blank input means no expiry", () => {
  const r = parseListingExpiry("", NOW)
  assert.equal(r.seconds, null)
  assert.equal(r.error, null)
})

test("whitespace-only input means no expiry", () => {
  const r = parseListingExpiry("   ", NOW)
  assert.equal(r.seconds, null)
  assert.equal(r.error, null)
})

test("a future datetime-local value converts to uint64 seconds", () => {
  const futureMs = (NOW + 3600) * 1000
  const local = new Date(futureMs)
  const pad = (n: number) => String(n).padStart(2, "0")
  const value = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`
  const r = parseListingExpiry(value, NOW)
  assert.equal(r.error, null)
  assert.equal(typeof r.seconds, "bigint")
  // Round-tripping through the datetime-local minute precision drops seconds.
  assert.ok(r.seconds !== null && r.seconds >= BigInt(NOW))
})

test("a past timestamp is rejected", () => {
  const r = parseListingExpiry("2020-01-01T00:00", NOW)
  assert.equal(r.seconds, null)
  assert.ok(r.error && /future/i.test(r.error))
})

test("the current instant is rejected (must be strictly future)", () => {
  const local = new Date(NOW * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  const value = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`
  const r = parseListingExpiry(value, NOW)
  assert.equal(r.seconds, null)
  assert.ok(r.error)
})

test("garbage input is rejected as invalid", () => {
  const r = parseListingExpiry("not-a-date", NOW)
  assert.equal(r.seconds, null)
  assert.equal(r.error, "Invalid date")
})
