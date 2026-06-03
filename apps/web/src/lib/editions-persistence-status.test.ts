/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/editions-persistence-status.test.ts
 *
 * Pure-function tests for the Phase 4 honest-status classification + status
 * mapping (no DB). The DB-backed read in editions-persistence.ts wires these to
 * cid_availability + token_pins.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { classifyArtworkKey, resolveArtworkStatus } from "./editions-persistence-status.ts"

test("classifyArtworkKey: empty -> none", () => {
  assert.deepEqual(classifyArtworkKey(""), { kind: "none", key: null })
})

test("classifyArtworkKey: ipfs:// -> ipfs + bare cid", () => {
  const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
  assert.deepEqual(classifyArtworkKey(`ipfs://${cid}`), { kind: "ipfs", key: cid })
})

test("classifyArtworkKey: ar:// -> arweave + tx id", () => {
  const id = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE" // 43-char shape
  assert.deepEqual(classifyArtworkKey(`ar://${id}`), { kind: "arweave", key: id })
})

test("classifyArtworkKey: plain https -> external (no key)", () => {
  assert.deepEqual(classifyArtworkKey("https://example.com/art.png"), {
    kind: "external",
    key: null,
  })
})

test("resolveArtworkStatus: probe verdict wins", () => {
  assert.equal(resolveArtworkStatus(true, false), "retrievable")
  assert.equal(resolveArtworkStatus(true, true), "retrievable")
  assert.equal(resolveArtworkStatus(false, false), "unretrievable")
  // A self-attested pin does NOT override a failed gateway probe (ground truth).
  assert.equal(resolveArtworkStatus(false, true), "unretrievable")
})

test("resolveArtworkStatus: pin is the fallback signal, else unprobed", () => {
  assert.equal(resolveArtworkStatus(null, true), "artist-pinned")
  assert.equal(resolveArtworkStatus(null, false), "unprobed")
})
