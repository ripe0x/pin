import assert from "node:assert/strict"
import test from "node:test"
import { manifestLookup, parseManifest } from "./manifest.ts"
import type { MediaRecord } from "./record.ts"

function record(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    contract: "0xabc",
    tokenId: "1",
    sourceUrl: "https://cdn.example/art.png",
    resolvedUrl: null,
    kind: "image",
    status: "ready",
    thumbnailUrl: "https://media.example/1.webp",
    posterUrl: null,
    width: 800,
    height: 600,
    durationMs: null,
    mimeType: "image/png",
    sourceBytes: 1000,
    derivativeBytes: 100,
    sourceSha256: null,
    derivativeSha256: null,
    preferredGateway: null,
    attemptCount: 1,
    lastError: null,
    lastAttemptAt: "2026-09-01T00:00:00.000Z",
    lastSuccessAt: "2026-09-01T00:00:00.000Z",
    nextAttemptAt: null,
    ...overrides,
  }
}

test("parseManifest round-trips a well-formed manifest", () => {
  const manifest = {
    version: 1 as const,
    generatedAt: "2026-09-01T00:00:00.000Z",
    records: { "0xabc:1": record() },
  }
  const parsed = parseManifest(manifest)
  assert.deepEqual(parsed, manifest)
})

test("parseManifest rejects a non-object root", () => {
  assert.throws(() => parseManifest(null), /root is not an object/)
  assert.throws(() => parseManifest("nope"), /root is not an object/)
})

test("parseManifest rejects the wrong version", () => {
  assert.throws(
    () => parseManifest({ version: 2, generatedAt: "x", records: {} }),
    /version must be 1/,
  )
})

test("parseManifest rejects a record with an invalid status", () => {
  assert.throws(
    () =>
      parseManifest({
        version: 1,
        generatedAt: "x",
        records: { "0xabc:1": record({ status: "done" as never }) },
      }),
    /invalid status/,
  )
})

test("parseManifest rejects a record keyed under the wrong contract/tokenId", () => {
  assert.throws(
    () =>
      parseManifest({
        version: 1,
        generatedAt: "x",
        records: { "0xabc:2": record() },
      }),
    /different contract\/tokenId/,
  )
})

test("manifestLookup resolves a ref to its record or null", () => {
  const manifest = parseManifest({
    version: 1,
    generatedAt: "x",
    records: { "0xabc:1": record() },
  })
  const lookup = manifestLookup(manifest)
  assert.equal(lookup({ contract: "0xABC", tokenId: "1" }), manifest.records["0xabc:1"])
  assert.equal(lookup({ contract: "0xabc", tokenId: "2" }), null)
})
