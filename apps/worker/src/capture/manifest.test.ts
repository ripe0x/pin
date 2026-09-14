/**
 * Run with: node --experimental-strip-types --test apps/worker/src/capture/manifest.test.ts
 * (same convention as packages/shared/src/ipfs.test.ts.) No network, no chain,
 * no Irys client -- pure functions plus a tmp-dir round trip for the record.
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertManifestStructure,
  buildArweavePathManifest,
  captureTemplate,
  computeCoverageBound,
  loadManifestRecord,
  manifestRecordPath,
  mergeTokenRecords,
  planCapture,
  saveManifestRecord,
  type CapturedTokenRecord,
  type CaptureManifestRecord,
} from "./manifest.ts"
import { verify404At, verifyBytesAt, type FetchLike, type FetchResponseLike } from "./verify.ts"
import { sha256Hex } from "./hash.ts"

function token(tokenId: number, itemId = `item-${tokenId}`): CapturedTokenRecord {
  return {
    tokenId,
    seed: `0xseed${tokenId}`,
    owner: "0xowner",
    sha256: `sha-${tokenId}`,
    itemId,
    capturedAt: "2026-01-01T00:00:00.000Z",
  }
}

function record(tokens: CapturedTokenRecord[]): CaptureManifestRecord {
  return {
    chain: "sepolia",
    collection: "0xcollection",
    renderAssets: "0xrenderassets",
    storageNetwork: "devnet",
    gateway: "https://devnet.irys.xyz",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tokens,
  }
}

test("captureTemplate: {id} placeholder over the manifest id", () => {
  assert.equal(captureTemplate("MANIFEST123"), "ar://MANIFEST123/{id}.png")
})

test("buildArweavePathManifest: one path per token, no fallback and no index", () => {
  const m = buildArweavePathManifest([
    { tokenId: 1, itemId: "item-1" },
    { tokenId: 2, itemId: "item-2" },
  ])
  assert.equal(m.manifest, "arweave/paths")
  assert.equal(m.version, "0.1.0")
  assert.deepEqual(m.paths, {
    "1.png": { id: "item-1" },
    "2.png": { id: "item-2" },
  })
  assert.equal("fallback" in m, false)
  assert.equal("index" in m, false)
})

test("buildArweavePathManifest: empty token list is an empty paths object", () => {
  const m = buildArweavePathManifest([])
  assert.deepEqual(m.paths, {})
})

test("assertManifestStructure: passes for a manifest whose paths match verified uploads", () => {
  const tokens = [
    { tokenId: 1, itemId: "item-1" },
    { tokenId: 2, itemId: "item-2" },
  ]
  const m = buildArweavePathManifest(tokens)
  assert.doesNotThrow(() => assertManifestStructure(m, tokens))
})

test("assertManifestStructure: rejects a path whose item id was not verified for that token", () => {
  const tokens = [{ tokenId: 1, itemId: "item-1" }]
  const m = buildArweavePathManifest(tokens)
  m.paths["1.png"] = { id: "not-the-verified-item" }
  assert.throws(() => assertManifestStructure(m, tokens), /does not match the verified upload/)
})

test("computeCoverageBound: contiguous ids from 1 bound at the last id", () => {
  assert.equal(computeCoverageBound([1, 2, 3, 4, 5]), 5)
})

test("computeCoverageBound: a gap stops the bound before it", () => {
  assert.equal(computeCoverageBound([1, 2, 4, 5]), 2)
})

test("computeCoverageBound: no token 1 bounds at 0", () => {
  assert.equal(computeCoverageBound([2, 3]), 0)
})

test("computeCoverageBound: empty set bounds at 0", () => {
  assert.equal(computeCoverageBound([]), 0)
})

test("planCapture: no prior record captures everything", () => {
  const candidates = [{ tokenId: 1 }, { tokenId: 2 }]
  assert.deepEqual(planCapture(candidates, null, false), candidates)
})

test("planCapture: skips tokenIds already in the prior record", () => {
  const candidates = [{ tokenId: 1 }, { tokenId: 2 }, { tokenId: 3 }]
  const prior = record([token(1), token(2)])
  assert.deepEqual(planCapture(candidates, prior, false), [{ tokenId: 3 }])
})

test("planCapture: --force re-captures everything regardless of the prior record", () => {
  const candidates = [{ tokenId: 1 }, { tokenId: 2 }]
  const prior = record([token(1), token(2)])
  assert.deepEqual(planCapture(candidates, prior, true), candidates)
})

test("mergeTokenRecords: appends new tokenIds after prior ones", () => {
  const prior = [token(1), token(2)]
  const fresh = [token(3)]
  const merged = mergeTokenRecords(prior, fresh)
  assert.deepEqual(
    merged.map((t) => t.tokenId),
    [1, 2, 3],
  )
})

test("mergeTokenRecords: a fresh entry replaces its prior tokenId in place, no duplicates", () => {
  const prior = [token(1), token(2, "stale-item-2")]
  const fresh = [token(2, "fresh-item-2")]
  const merged = mergeTokenRecords(prior, fresh)
  assert.deepEqual(
    merged.map((t) => t.tokenId),
    [1, 2],
  )
  assert.equal(merged.find((t) => t.tokenId === 2)?.itemId, "fresh-item-2")
})

test("partial run: prior record with cover + 2 of 5 tokens leaves only the missing 3 to capture", () => {
  const prior = record([token(1), token(2)])
  prior.coverItemId = "cover-item-existing"
  const candidates = [1, 2, 3, 4, 5].map((tokenId) => ({ tokenId }))
  const toCapture = planCapture(candidates, prior, false)
  assert.deepEqual(
    toCapture.map((t) => t.tokenId),
    [3, 4, 5],
  )
  // A retry reuses the cover and both already-uploaded token item ids
  // instead of re-uploading them.
  assert.equal(prior.coverItemId, "cover-item-existing")
  assert.deepEqual(
    prior.tokens.map((t) => t.itemId),
    ["item-1", "item-2"],
  )
})

test("manifest record round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-manifest-test-"))
  try {
    const path = manifestRecordPath(dir, "sepolia")
    assert.equal(loadManifestRecord(path), null)
    const rec = record([token(1)])
    saveManifestRecord(path, rec)
    assert.deepEqual(loadManifestRecord(path), rec)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// -- verify.ts: gating checks against a stubbed fetch, no network --------

function stubFetch(byUrl: Record<string, { status: number; body?: Buffer }>): FetchLike {
  return async (url: string): Promise<FetchResponseLike> => {
    const entry = byUrl[url]
    if (!entry) throw new Error(`unexpected fetch: ${url}`)
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      arrayBuffer: async () => {
        const buf = entry.body ?? Buffer.alloc(0)
        return new Uint8Array(buf).buffer
      },
    }
  }
}

test("verifyBytesAt: passes when the fetched bytes hash to the expected sha256", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-verify-test-"))
  try {
    const body = Buffer.from("hello")
    const fetchFn = stubFetch({ "https://gw/x": { status: 200, body } })
    await assert.doesNotReject(
      verifyBytesAt(fetchFn, "https://gw/x", join(dir, "out.png"), sha256Hex(body), "test"),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("verifyBytesAt: throws on a sha256 mismatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-verify-test-"))
  try {
    const fetchFn = stubFetch({ "https://gw/x": { status: 200, body: Buffer.from("hello") } })
    await assert.rejects(
      verifyBytesAt(fetchFn, "https://gw/x", join(dir, "out.png"), "not-the-real-hash", "test"),
      /sha256 mismatch/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("verify404At: passes when the gateway returns 404 for an id beyond the bound", async () => {
  const fetchFn = stubFetch({ "https://gw/m/6.png": { status: 404 } })
  await assert.doesNotReject(verify404At(fetchFn, "https://gw/m/6.png", "beyond bound"))
})

test("verify404At: throws when an id supposedly beyond the bound actually resolves", async () => {
  const fetchFn = stubFetch({ "https://gw/m/6.png": { status: 200, body: Buffer.from("oops") } })
  await assert.rejects(verify404At(fetchFn, "https://gw/m/6.png", "beyond bound"), /expected HTTP 404/)
})
