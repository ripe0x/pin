/**
 * Run with: node --experimental-strip-types --test packages/shared/src/ipfs.test.ts
 *
 * Pure-function tests for URI → HTTP gateway resolution. Focused on the
 * Arweave (`ar://`) path added for PND Editions media, plus a couple of
 * IPFS/IPNS regression checks so the shared resolver stays honest.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { ipfsToHttp, ARWEAVE_GATEWAY } from "./ipfs.ts"

test("ipfsToHttp resolves ar:// to the Arweave gateway", () => {
  const id = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE" // 43-char-ish shape
  assert.equal(ipfsToHttp(`ar://${id}`), `${ARWEAVE_GATEWAY}/${id}`)
})

test("ipfsToHttp preserves a sub-path after the Arweave id", () => {
  assert.equal(ipfsToHttp("ar://txid123/art.png"), `${ARWEAVE_GATEWAY}/txid123/art.png`)
})

test("ipfsToHttp leaves a bare ar:// (no id) unchanged", () => {
  assert.equal(ipfsToHttp("ar://"), "ar://")
})

test("ipfsToHttp still resolves ipfs:// to a gateway", () => {
  const out = ipfsToHttp("ipfs://QmTest")
  assert.ok(out.startsWith("https://") && out.includes("/ipfs/QmTest"))
})

test("ipfsToHttp passes through a plain https arweave.net URL", () => {
  const url = "https://arweave.net/txid123"
  assert.equal(ipfsToHttp(url), url)
})

test("ipfsToHttp passes through an unrelated https URL", () => {
  const url = "https://example.com/art.png"
  assert.equal(ipfsToHttp(url), url)
})
