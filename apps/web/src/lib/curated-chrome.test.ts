/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/curated-chrome.test.ts
 *
 * Chrome resolution for curated immersive pages. Same zero-framework pattern
 * as mint-phases.test.ts. Node's strip-types runner can only load leaf
 * modules with explicit extensions, so this can't import the descriptor
 * registry (mint-collections.ts uses bundler-style extensionless imports) —
 * the registry↔chrome sync contract is documented in both files: a descriptor
 * that sets `customLayout` MUST have its slug + address mapped here.
 *
 * Env is set BEFORE the dynamic import: curated-chrome.ts reads
 * NEXT_PUBLIC_HOMAGE_ADDRESS at module scope.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"

const HOMAGE = "0x1111111111111111111111111111111111111111"
process.env.NEXT_PUBLIC_HOMAGE_ADDRESS = HOMAGE

const { chromeForPath } = await import("./curated-chrome.ts")

const DEFAULT = chromeForPath("/")

test("default chrome is the standard shell", () => {
  assert.deepEqual(DEFAULT, { navbar: "solid", footer: true, padTop: true })
})

test("homage collection page is immersive by slug and by address, any case", () => {
  for (const seg of ["homage", "HOMAGE", HOMAGE, HOMAGE.toUpperCase().replace("0X", "0x")]) {
    const chrome = chromeForPath(`/mint/${seg}`)
    assert.equal(chrome.navbar, "overlay-dark", `/mint/${seg}`)
    assert.equal(chrome.footer, false)
    assert.equal(chrome.padTop, false)
  }
})

test("trailing slash still resolves immersive", () => {
  assert.equal(chromeForPath("/mint/homage/").navbar, "overlay-dark")
})

test("token pages keep standard chrome", () => {
  assert.deepEqual(chromeForPath("/mint/homage/123"), DEFAULT)
  assert.deepEqual(chromeForPath(`/mint/${HOMAGE}/123`), DEFAULT)
})

test("other routes keep standard chrome", () => {
  for (const p of ["/", "/mint", "/mint/vouch", "/mint/vouch/12", "/artist/0xabc", "/homage"]) {
    assert.deepEqual(chromeForPath(p), DEFAULT, p)
  }
})
