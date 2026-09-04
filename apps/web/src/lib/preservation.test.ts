/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/preservation.test.ts
 *
 * The grade model is the load-bearing honesty boundary: it must never assert
 * a tier it cannot back, and must degrade to "not declared" on unknowns.
 * These pin the fact matrix, including the unknown-renderer case.
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  gradePreservation,
  preservationOverride,
  runtimeKindOf,
  type PreservationFacts,
} from "./preservation.ts"

test("runtimeKindOf classifies render shapes honestly", () => {
  assert.equal(runtimeKindOf("data:image/svg+xml,x", null), "solidity-svg")
  assert.equal(runtimeKindOf(null, "data:text/html;base64,x"), "html-js")
  // A proxied live render (escape): present but unclassifiable animation must
  // not be called static.
  assert.equal(runtimeKindOf("", "/api/escape/1"), "unknown")
  assert.equal(runtimeKindOf("https://img/x.png", null), "static-image")
  assert.equal(runtimeKindOf(null, null), "unknown")
})

const base: PreservationFacts = {
  rendererLocked: false,
  runtime: "unknown",
  codeOnchain: null,
  hasCapture: null,
  hasCover: false,
  declared: null,
}

const labels = (f: PreservationFacts) => gradePreservation(f).facts.map((x) => x.label)

test("solidity-svg with onchain code derives Pure onchain", () => {
  const g = gradePreservation({ ...base, runtime: "solidity-svg", codeOnchain: true, rendererLocked: true })
  assert.equal(g.summary, "Pure onchain")
  assert.ok(labels({ ...base, runtime: "solidity-svg" }).some((l) => l.includes("onchain SVG")))
})

test("html-js with onchain code but no declaration stays honest", () => {
  const g = gradePreservation({ ...base, runtime: "html-js", codeOnchain: true })
  assert.equal(g.summary, "Onchain code, liveness not declared")
  assert.ok(g.facts.some((x) => x.label === "Art code stored onchain" && x.tone === "good"))
})

test("unknown renderer reports Liveness not declared, no invented facts", () => {
  const g = gradePreservation({ ...base, runtime: "unknown", codeOnchain: null, hasCover: true })
  assert.equal(g.summary, "Liveness not declared")
  // No runtime fact, no code fact, cover present so no cover note: only the
  // renderer-lock fact survives.
  assert.deepEqual(labels({ ...base, hasCover: true }), [
    "Renderer can still be changed by the artist",
  ])
})

test("declared chain-live surfaces the note and Chain-live summary", () => {
  const g = gradePreservation({
    ...base,
    runtime: "html-js",
    codeOnchain: true,
    rendererLocked: true,
    declared: { tier: "chain-live", note: "Reads live CryptoPunks onchain state" },
  })
  assert.equal(g.summary, "Chain-live")
  assert.ok(g.facts.some((x) => x.label === "Reads live CryptoPunks onchain state"))
})

test("declared external-live is flagged caution", () => {
  const g = gradePreservation({
    ...base,
    declared: { tier: "external-live", note: "Reads an offchain URL" },
  })
  assert.equal(g.summary, "External-live")
  assert.ok(g.facts.some((x) => x.label === "Reads an offchain URL" && x.tone === "caution"))
})

test("renderer lock flips tone", () => {
  assert.ok(
    gradePreservation({ ...base, rendererLocked: true }).facts.some(
      (x) => x.label === "Renderer locked permanently" && x.tone === "good",
    ),
  )
  assert.ok(
    gradePreservation({ ...base, rendererLocked: false }).facts.some(
      (x) => x.tone === "caution",
    ),
  )
})

test("capture on a chain-live work is a snapshot, not the work", () => {
  const g = gradePreservation({
    ...base,
    hasCapture: true,
    declared: { tier: "chain-live", note: "Reads live state" },
  })
  assert.ok(g.facts.some((x) => x.label.includes("snapshot") && x.tone === "neutral"))
  assert.ok(!g.facts.some((x) => x.label === "Static image captured onchain"))
})

test("capture on a pure work is a good fact", () => {
  const g = gradePreservation({ ...base, hasCapture: true, runtime: "solidity-svg", codeOnchain: true })
  assert.ok(g.facts.some((x) => x.label === "Static image captured onchain" && x.tone === "good"))
})

test("no capture reports not-yet-captured", () => {
  assert.ok(labels({ ...base, hasCapture: false }).includes("Static image not yet captured"))
})

test("cover-only collection is never graded archival-complete", () => {
  // hasCapture null (collection level), cover set: no capture claim at all.
  const g = gradePreservation({ ...base, hasCover: true, runtime: "unknown" })
  assert.ok(!g.facts.some((x) => x.label.toLowerCase().includes("captured")))
  assert.notEqual(g.summary, "Pure onchain")
})

test("Homage override resolves chain-live", () => {
  const o = preservationOverride("0xD938FF57D2C7111880A4EA5C8E6A92796C72A76E")
  assert.equal(o?.tier, "chain-live")
  assert.ok(o?.note.includes("CryptoPunks"))
})

test("unlisted collection has no override", () => {
  assert.equal(preservationOverride("0x0000000000000000000000000000000000000001"), null)
})
