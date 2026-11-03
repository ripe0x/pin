import { strict as assert } from "node:assert"
import { test } from "node:test"
import { scanRange, ScanRangeError } from "./scan-range.ts"

type Range = [bigint, bigint]

/**
 * Fake RPC: "logs" live at fixed blocks; any request whose range overlaps
 * a poisoned block, or is larger than `maxRange`, throws.
 */
function fakeClient(opts: {
  logBlocks: bigint[]
  poisoned?: bigint[]
  maxRange?: bigint
}) {
  const calls: Range[] = []
  const fetch = async (from: bigint, to: bigint): Promise<bigint[]> => {
    calls.push([from, to])
    if (opts.maxRange !== undefined && to - from + 1n > opts.maxRange) {
      throw new Error(`range too large: ${from}-${to}`)
    }
    for (const p of opts.poisoned ?? []) {
      if (p >= from && p <= to) throw new Error(`upstream error at ${p}`)
    }
    return opts.logBlocks.filter((b) => b >= from && b <= to)
  }
  return { fetch, calls }
}

/** Assert the processed ranges tile [from, scannedTo] exactly, in order. */
function assertContiguous(processed: Range[], from: bigint, scannedTo: bigint) {
  let expected = from
  for (const [a, b] of processed) {
    assert.equal(a, expected, `gap or overlap before ${a}`)
    assert.ok(b >= a)
    expected = b + 1n
  }
  assert.equal(expected - 1n, scannedTo)
}

test("clean scan walks every chunk and reports the full range", async () => {
  const { fetch } = fakeClient({ logBlocks: [5n, 150n, 299n] })
  const seen: bigint[] = []
  const processed: Range[] = []
  const r = await scanRange({
    from: 0n, to: 299n, chunkSize: 100n,
    fetch,
    process: (logs, a, b) => { seen.push(...logs); processed.push([a, b]) },
  })
  assert.equal(r.error, null)
  assert.equal(r.scannedTo, 299n)
  assert.equal(r.chunks, 3)
  assert.deepEqual(seen, [5n, 150n, 299n])
  assertContiguous(processed, 0n, 299n)
})

test("a range-size rejection is split until it succeeds, with no gaps", async () => {
  // Provider caps ranges at 1,000 blocks; we ask for 10,000.
  const { fetch, calls } = fakeClient({
    logBlocks: [10n, 2_500n, 9_999n],
    maxRange: 1_000n,
  })
  const seen: bigint[] = []
  const processed: Range[] = []
  const r = await scanRange({
    from: 0n, to: 9_999n, chunkSize: 10_000n, minChunkSize: 100n,
    fetch,
    process: (logs, a, b) => { seen.push(...logs); processed.push([a, b]) },
  })
  assert.equal(r.error, null)
  assert.equal(r.scannedTo, 9_999n)
  assert.deepEqual(seen, [10n, 2_500n, 9_999n])
  assertContiguous(processed, 0n, 9_999n)
  assert.ok(calls.length > 1, "expected split retries")
  for (const [a, b] of processed) assert.ok(b - a + 1n <= 1_000n)
})

test("a persistent failure stops the scan just before the bad block", async () => {
  const { fetch } = fakeClient({ logBlocks: [100n, 4_000n, 6_000n], poisoned: [5_000n] })
  const seen: bigint[] = []
  const processed: Range[] = []
  const r = await scanRange({
    from: 0n, to: 9_999n, chunkSize: 2_000n, minChunkSize: 100n,
    fetch,
    process: (logs, a, b) => { seen.push(...logs); processed.push([a, b]) },
  })
  assert.ok(r.error instanceof ScanRangeError)
  // The cursor never reaches the poisoned block...
  assert.ok(r.scannedTo < 5_000n, `scannedTo ${r.scannedTo} passed the failure`)
  // ...but makes progress up to within one floor-sized range of it.
  assert.ok(r.scannedTo >= 5_000n - 100n, `scannedTo ${r.scannedTo} gave up too early`)
  assert.ok(r.error!.from <= 5_000n && r.error!.to >= 5_000n)
  assert.ok(r.error!.to - r.error!.from + 1n <= 100n)
  // Nothing past the failure was processed, and 6_000 was never recorded.
  assert.deepEqual(seen, [100n, 4_000n])
  assertContiguous(processed, 0n, r.scannedTo)
})

test("a failure in the very first floor-sized range leaves the cursor untouched", async () => {
  const { fetch } = fakeClient({ logBlocks: [], poisoned: [1_000n] })
  const r = await scanRange({
    from: 1_000n, to: 50_000n, chunkSize: 10_000n, minChunkSize: 100n, fetch,
  })
  assert.ok(r.error)
  assert.equal(r.scannedTo, 999n) // from - 1n: nothing scanned
})

test("a chunk at or below the floor is not split", async () => {
  const { fetch, calls } = fakeClient({ logBlocks: [], poisoned: [10n] })
  const r = await scanRange({
    from: 0n, to: 49n, chunkSize: 50n, minChunkSize: 100n, fetch,
  })
  assert.ok(r.error)
  assert.equal(calls.length, 1)
  assert.equal(r.scannedTo, -1n)
})

test("an outage across every provider records nothing as scanned", async () => {
  const fetch = async () => { throw new Error("all providers down") }
  const r = await scanRange({
    from: 20_000_000n, to: 20_100_000n, chunkSize: 10_000n, fetch,
  })
  assert.ok(r.error)
  assert.equal(r.scannedTo, 19_999_999n)
})

test("a process (DB) error stops the scan without splitting", async () => {
  const { fetch, calls } = fakeClient({ logBlocks: [150n] })
  const r = await scanRange({
    from: 0n, to: 999n, chunkSize: 100n,
    fetch,
    process: (logs) => { if (logs.length > 0) throw new Error("db down") },
  })
  assert.ok(r.error)
  assert.equal(r.scannedTo, 99n)
  assert.equal(calls.length, 2)
})

test("commit sees a monotonically increasing cursor that never passes a failure", async () => {
  const { fetch } = fakeClient({ logBlocks: [], poisoned: [3_333n] })
  const commits: bigint[] = []
  const r = await scanRange({
    from: 0n, to: 9_999n, chunkSize: 1_000n,
    fetch,
    commit: (n) => { commits.push(n) },
  })
  assert.ok(r.error)
  for (let i = 1; i < commits.length; i++) assert.ok(commits[i] > commits[i - 1])
  assert.ok(commits.every((c) => c < 3_333n))
  assert.equal(commits.at(-1), r.scannedTo)
})

test("maxChunks bounds a tick without reporting an error", async () => {
  const { fetch } = fakeClient({ logBlocks: [] })
  const r = await scanRange({
    from: 0n, to: 99_999n, chunkSize: 1_000n, maxChunks: 5, fetch,
  })
  assert.equal(r.error, null)
  assert.equal(r.chunks, 5)
  assert.equal(r.scannedTo, 4_999n)
})

test("an empty range (from > to) makes no calls", async () => {
  const { fetch, calls } = fakeClient({ logBlocks: [] })
  const r = await scanRange({ from: 10n, to: 9n, chunkSize: 100n, fetch })
  assert.equal(r.error, null)
  assert.equal(r.scannedTo, 9n)
  assert.equal(calls.length, 0)
})
