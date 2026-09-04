import assert from "node:assert/strict"
import test from "node:test"
import { toProviderViewState } from "./state.ts"

test("provider states keep loading, reduced, and blocked meanings distinct", () => {
  assert.equal(toProviderViewState(null, true, null).phase, "loading")
  const reduced = toProviderViewState({
    status: "partial",
    value: { price: 1n },
    missing: ["history"],
    evidence: { truth: "protocol", source: "fixture" },
  }, false, 1)
  assert.equal(reduced.phase, "reduced")
  assert.deepEqual(reduced.value, { price: 1n })
  const blocked = toProviderViewState({
    status: "unavailable",
    reason: "RPC timeout",
    retryable: true,
  }, false, 2)
  assert.equal(blocked.phase, "blocked")
  assert.equal(blocked.retryable, true)
})
