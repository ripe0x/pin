/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/collection-render/build.test.ts
 *
 * Pins the byte-exact shape of the injected tokenData script defined by
 * docs/injection-convention.md (field order, string vs number types,
 * lowercase hex, the context field, trailing `"};`), the same bytes the
 * removed onchain reference renderer's `_contextJs` emitted. Catches drift
 * in the injection line cheaply, on every change.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { buildContextJs } from "./build.ts"

const SEED =
  "0xAB00000000000000000000000000000000000000000000000000000000000001"
const COLLECTION = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"

test("buildContextJs emits the convention's injection line byte for byte", () => {
  const js = buildContextJs({
    hash: SEED,
    tokenId: "7",
    collection: COLLECTION,
    chainId: 1,
    version: 1,
    context: "token",
  })
  assert.equal(
    js,
    'window.tokenData={"hash":"' +
      SEED.toLowerCase() +
      '","tokenId":"7","collection":"' +
      COLLECTION.toLowerCase() +
      '","chainId":1,"version":1,"context":"token"};',
  )
})

test("preview and capture contexts inject verbatim", () => {
  for (const context of ["preview", "capture"] as const) {
    const js = buildContextJs({
      hash: SEED,
      tokenId: "1",
      collection: COLLECTION,
      chainId: 1,
      version: 1,
      context,
    })
    assert.ok(js.endsWith(',"context":"' + context + '"};'))
  }
})
