/**
 * Run with: node --experimental-strip-types --test src/sovereignV2Status.test.ts
 * (from apps/indexer). Node 22's native TypeScript support handles this file
 * directly — no ponder:registry/ponder:schema imports here, so it needs no
 * live indexer environment, unlike SovereignV2.ts itself.
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { resolveLotUnwoundStatus } from "./sovereignV2Status.ts"

test("LotUnwound on a still-deferred row resolves to unwound (return-to-seller succeeded)", () => {
  assert.equal(resolveLotUnwoundStatus("deferred"), "unwound")
})

test("LotUnwound keeps unwound_return_pending when LotReturnDeferred already set it in the same tx", () => {
  assert.equal(resolveLotUnwoundStatus("unwound_return_pending"), "unwound_return_pending")
})

test("LotUnwound is idempotent on an already-unwound row", () => {
  assert.equal(resolveLotUnwoundStatus("unwound"), "unwound")
})

test("an unrelated status still resolves to unwound (defensive default)", () => {
  assert.equal(resolveLotUnwoundStatus("active"), "unwound")
})
