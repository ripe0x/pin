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
 * NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS at module scope (the sovereign-rebuild's
 * mint engine — the descriptor's primary `address` — not the separate pooled
 * collection). NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS is the pooled
 * collection's own address, read separately for the /collections/<addr> branch.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"

const HOMAGE = "0x1111111111111111111111111111111111111111"
const HOMAGE_COLLECTION = "0x2222222222222222222222222222222222222222"
process.env.NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS = HOMAGE
process.env.NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS = HOMAGE_COLLECTION

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

test("homage's own /collections/<address> page is immersive, any case, with trailing slash", () => {
  for (const seg of [
    HOMAGE_COLLECTION,
    HOMAGE_COLLECTION.toUpperCase().replace("0X", "0x"),
  ]) {
    const chrome = chromeForPath(`/collections/${seg}`)
    assert.equal(chrome.navbar, "overlay-dark", `/collections/${seg}`)
    assert.equal(chrome.footer, false)
    assert.equal(chrome.padTop, false)
  }
  assert.equal(chromeForPath(`/collections/${HOMAGE_COLLECTION}/`).navbar, "overlay-dark")
})

test("pre-deploy /collections/homage landing is immersive by slug (env-independent)", () => {
  for (const seg of ["homage", "HOMAGE"]) {
    const chrome = chromeForPath(`/collections/${seg}`)
    assert.equal(chrome.navbar, "overlay-dark", `/collections/${seg}`)
    assert.equal(chrome.footer, false)
    assert.equal(chrome.padTop, false)
  }
})

test("homage token detail + redeem sub-pages are immersive (one segment deep)", () => {
  for (const sub of ["redeem", "3104"]) {
    const chrome = chromeForPath(`/collections/${HOMAGE_COLLECTION}/${sub}`)
    assert.equal(chrome.navbar, "overlay-dark", `/collections/.../${sub}`)
    assert.equal(chrome.footer, false)
    assert.equal(chrome.padTop, false)
  }
  // A token's /live doc is two segments deep — standard chrome.
  assert.deepEqual(chromeForPath(`/collections/${HOMAGE_COLLECTION}/3104/live`), DEFAULT)
})

test("other /collections/<address> pages keep standard chrome", () => {
  assert.deepEqual(
    chromeForPath("/collections/0x3333333333333333333333333333333333333333"),
    DEFAULT,
  )
  // Token sub-pages under a NON-homage collection stay standard.
  assert.deepEqual(chromeForPath("/collections/0x3333333333333333333333333333333333333333/7"), DEFAULT)
})
