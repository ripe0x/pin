import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  createSafeHeadReader, pickSafeHead, replayOverlap, scanConfirmations,
} from "./finality.ts"

test("SCAN_CONFIRMATIONS / SCAN_REPLAY_OVERLAP parse, defaulting to 12", () => {
  assert.equal(scanConfirmations(undefined), 12n)
  assert.equal(scanConfirmations(""), 12n)
  assert.equal(scanConfirmations("32"), 32n)
  assert.equal(scanConfirmations("-5"), 12n)
  assert.equal(scanConfirmations("abc"), 12n)
  assert.equal(replayOverlap(undefined), 12n)
  assert.equal(replayOverlap("0"), 0n)
  assert.equal(replayOverlap("64"), 64n)
})

test("pickSafeHead prefers the finalized block", () => {
  assert.deepEqual(
    pickSafeHead({ finalized: 1_000n, latest: null, confirmations: 12n }),
    { block: 1_000n, source: "finalized" },
  )
})

test("pickSafeHead never goes past a provider's lower latest", () => {
  // A lagging provider's latest below finalized caps the scan there.
  assert.deepEqual(
    pickSafeHead({ finalized: 1_000n, latest: 990n, confirmations: 12n }),
    { block: 990n, source: "finalized" },
  )
})

test("pickSafeHead falls back to latest - confirmations", () => {
  assert.deepEqual(
    pickSafeHead({ finalized: null, latest: 1_000n, confirmations: 12n }),
    { block: 988n, source: "confirmations" },
  )
  // A zero/garbage finalized number is treated as unavailable.
  assert.deepEqual(
    pickSafeHead({ finalized: 0n, latest: 1_000n, confirmations: 12n }),
    { block: 988n, source: "confirmations" },
  )
  // Near genesis it floors at 0 instead of going negative.
  assert.deepEqual(
    pickSafeHead({ finalized: null, latest: 5n, confirmations: 12n }),
    { block: 0n, source: "confirmations" },
  )
})

test("pickSafeHead throws when nothing is available", () => {
  assert.throws(() => pickSafeHead({ finalized: null, latest: null, confirmations: 12n }))
})

function fakeClient(opts: { finalized?: bigint | Error; latest?: bigint }) {
  const calls: string[] = []
  return {
    calls,
    client: {
      getBlock: async () => {
        calls.push("finalized")
        if (opts.finalized instanceof Error) throw opts.finalized
        return { number: opts.finalized ?? null }
      },
      getBlockNumber: async () => {
        calls.push("latest")
        return opts.latest ?? 0n
      },
    },
  }
}

test("reader uses the finalized tag with one call, then serves the cache", async () => {
  let now = 0
  const { client, calls } = fakeClient({ finalized: 500n, latest: 600n })
  const reader = createSafeHeadReader(client, { confirmations: 12n, ttlMs: 10_000, now: () => now })
  assert.deepEqual(await reader.get(), { block: 500n, source: "finalized", rpcCalls: 1 })
  now = 5_000
  assert.deepEqual(await reader.get(), { block: 500n, source: "finalized", rpcCalls: 0 })
  assert.deepEqual(calls, ["finalized"])
  now = 10_000 // expired
  assert.equal((await reader.get()).rpcCalls, 1)
  assert.deepEqual(calls, ["finalized", "finalized"])
})

test("reader falls back to latest - confirmations when finalized fails", async () => {
  const { client, calls } = fakeClient({ finalized: new Error("unknown block tag"), latest: 1_000n })
  const reader = createSafeHeadReader(client, { confirmations: 12n, now: () => 0 })
  assert.deepEqual(await reader.get(), { block: 988n, source: "confirmations", rpcCalls: 2 })
  assert.deepEqual(calls, ["finalized", "latest"])
})

test("confirmed mode skips the finalized tag and is cached separately", async () => {
  const { client, calls } = fakeClient({ finalized: 500n, latest: 1_000n })
  const reader = createSafeHeadReader(client, { confirmations: 12n, now: () => 0 })
  assert.deepEqual(await reader.get("confirmed"), { block: 988n, source: "confirmations", rpcCalls: 1 })
  assert.deepEqual(await reader.get("finalized"), { block: 500n, source: "finalized", rpcCalls: 1 })
  assert.deepEqual(calls, ["latest", "finalized"])
})
