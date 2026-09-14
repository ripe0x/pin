import assert from "node:assert/strict"
import test from "node:test"
import { derivativeKey } from "./derivative.ts"

test("derivative keys are content-addressed and path-safe", () => {
  const hash = "a".repeat(64)
  assert.equal(derivativeKey("media-cache/v1", hash, ".webp"), `media-cache/v1/aa/${hash}.webp`)
  assert.equal(derivativeKey("/media/", hash, "webp"), `media/aa/${hash}.webp`)
})

test("derivativeKey rejects a malformed hash or empty extension", () => {
  assert.throws(() => derivativeKey("media", "not-a-hash", "webp"))
  assert.throws(() => derivativeKey("media", "a".repeat(64), ""))
})
