/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/metadata-host.test.ts
 *
 * Pure-function tests for the URL → HostBucket classifier used by the
 * Display path section of the dependency report. Mirrors the style of
 * `parseEthAmount.test.ts` (Node's built-in test runner; no framework).
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  classifyUrl,
  extractBareCid,
  fingerprintToken,
  type HostBucket,
} from "./metadata-host.ts"

function expectBucket(url: string | null, expected: HostBucket, expectedHost?: string) {
  const got = classifyUrl(url)
  assert.equal(
    got.bucket,
    expected,
    `expected ${expected} for ${JSON.stringify(url)}, got ${JSON.stringify(got)}`,
  )
  if (expectedHost !== undefined) {
    assert.equal(
      got.host,
      expectedHost,
      `expected host ${expectedHost} for ${JSON.stringify(url)}, got ${JSON.stringify(got.host)}`,
    )
  }
}

// ─── ipfs ──────────────────────────────────────────────────────────────────

test("classifies ipfs:// scheme as ipfs", () => {
  expectBucket("ipfs://QmHashHashHash", "ipfs")
  expectBucket("ipfs://bafybeigdyrztgcfa/metadata.json", "ipfs")
})

test("classifies known IPFS gateway hosts as ipfs", () => {
  expectBucket("https://ipfs.io/ipfs/QmFoo", "ipfs")
  expectBucket("https://dweb.link/ipfs/QmFoo", "ipfs")
  expectBucket("https://w3s.link/ipfs/QmFoo", "ipfs")
  expectBucket("https://cf-ipfs.com/ipfs/QmFoo", "ipfs")
  expectBucket("https://nftstorage.link/ipfs/QmFoo", "ipfs")
  expectBucket("https://gateway.pinata.cloud/ipfs/QmFoo", "ipfs")
})

test("classifies subdomain-style IPFS gateways as ipfs", () => {
  expectBucket("https://bafybeicid.ipfs.dweb.link/metadata.json", "ipfs")
  expectBucket("https://qmHash.ipfs.nftstorage.link/", "ipfs")
  expectBucket("https://bafy.ipfs.w3s.link", "ipfs")
})

// ─── arweave ───────────────────────────────────────────────────────────────

test("classifies ar:// scheme as arweave", () => {
  expectBucket("ar://abc123", "arweave")
})

test("classifies arweave.net host as arweave", () => {
  expectBucket("https://arweave.net/abc123", "arweave")
  expectBucket("https://gateway.arweave.net/tx/abc", "arweave")
})

// ─── onchain ───────────────────────────────────────────────────────────────

test("classifies data: URIs as onchain", () => {
  expectBucket("data:application/json;base64,eyJuYW1lIjoiZm9vIn0=", "onchain")
  expectBucket("data:application/json,{\"name\":\"foo\"}", "onchain")
  expectBucket("data:image/svg+xml;base64,PHN2Zy8+", "onchain")
  expectBucket("data:image/png;base64,iVBORw0K", "onchain")
})

// ─── centralized ───────────────────────────────────────────────────────────

test("classifies arbitrary http(s) hosts as centralized with hostname", () => {
  expectBucket("https://api.opensea.io/api/v1/asset/0x/1", "centralized", "api.opensea.io")
  expectBucket("https://artist.example.com/token/42.json", "centralized", "artist.example.com")
  expectBucket("http://example.com/foo.png", "centralized", "example.com")
})

test("centralized host is lowercased even when URL is mixed case", () => {
  expectBucket("https://API.Example.COM/foo", "centralized", "api.example.com")
})

// ─── unresolved ────────────────────────────────────────────────────────────

test("classifies null / empty / whitespace as unresolved", () => {
  expectBucket(null, "unresolved")
  expectBucket("", "unresolved")
  expectBucket("   ", "unresolved")
})

test("classifies unparseable / unknown-scheme URLs as unresolved", () => {
  expectBucket("not a url", "unresolved")
  expectBucket("ftp://example.com/foo", "unresolved")
  expectBucket("file:///etc/passwd", "unresolved")
})

// ─── fingerprintToken ──────────────────────────────────────────────────────

test("fingerprintToken classifies metadata and media independently", () => {
  const fp = fingerprintToken({
    rawUri: "ipfs://QmJsonHash",
    imageUrl: "https://artist.example.com/img.png",
    animationUrl: null,
  })
  assert.equal(fp.metadata.bucket, "ipfs")
  assert.equal(fp.media.bucket, "centralized")
  assert.equal(fp.media.host, "artist.example.com")
})

test("fingerprintToken falls back to animation_url when image_url is null", () => {
  const fp = fingerprintToken({
    rawUri: null,
    imageUrl: null,
    animationUrl: "ar://abc",
  })
  assert.equal(fp.metadata.bucket, "unresolved")
  assert.equal(fp.media.bucket, "arweave")
})

test("fingerprintToken handles all-null row as unresolved/unresolved", () => {
  const fp = fingerprintToken({
    rawUri: null,
    imageUrl: null,
    animationUrl: null,
  })
  assert.equal(fp.metadata.bucket, "unresolved")
  assert.equal(fp.media.bucket, "unresolved")
})

// ─── extractBareCid ────────────────────────────────────────────────────────

test("extractBareCid pulls v0 CID from ipfs:// scheme", () => {
  assert.equal(
    extractBareCid("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"),
    "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  )
})

test("extractBareCid pulls v1 CID from ipfs:// scheme", () => {
  assert.equal(
    extractBareCid("ipfs://bafybeigdyrztgcfa5fxlzg2dnpvvk6jrcljkfzfm5pn4llgf3xkqkyvcxe"),
    "bafybeigdyrztgcfa5fxlzg2dnpvvk6jrcljkfzfm5pn4llgf3xkqkyvcxe",
  )
})

test("extractBareCid strips trailing path and query", () => {
  assert.equal(
    extractBareCid("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/metadata.json?key=v"),
    "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  )
})

test("extractBareCid handles legacy ipfs://ipfs/<cid> form", () => {
  assert.equal(
    extractBareCid("ipfs://ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"),
    "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  )
})

test("extractBareCid pulls CID from path gateway", () => {
  assert.equal(
    extractBareCid("https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"),
    "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  )
  assert.equal(
    extractBareCid("https://dweb.link/ipfs/bafybeigdyrztgcfa5fxlzg2dnpvvk6jrcljkfzfm5pn4llgf3xkqkyvcxe/foo.json"),
    "bafybeigdyrztgcfa5fxlzg2dnpvvk6jrcljkfzfm5pn4llgf3xkqkyvcxe",
  )
})

test("extractBareCid pulls CID from subdomain gateway", () => {
  assert.equal(
    extractBareCid("https://bafybeigdyrztgcfa5fxlzg2dnpvvk6jrcljkfzfm5pn4llgf3xkqkyvcxe.ipfs.dweb.link/meta.json"),
    "bafybeigdyrztgcfa5fxlzg2dnpvvk6jrcljkfzfm5pn4llgf3xkqkyvcxe",
  )
})

test("extractBareCid returns null for non-IPFS URLs", () => {
  assert.equal(extractBareCid("https://arweave.net/abc123"), null)
  assert.equal(extractBareCid("ar://abc123"), null)
  assert.equal(extractBareCid("data:application/json;base64,xx"), null)
  assert.equal(extractBareCid("https://artist.example.com/token/1.json"), null)
  assert.equal(extractBareCid(null), null)
  assert.equal(extractBareCid(""), null)
})

test("extractBareCid returns null when IPFS-shaped URL has no CID-shaped token", () => {
  assert.equal(extractBareCid("ipfs://not-a-cid"), null)
  assert.equal(extractBareCid("https://ipfs.io/ipfs/totally-bogus"), null)
})
