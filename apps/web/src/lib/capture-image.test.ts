import { strict as assert } from "node:assert"
import { test } from "node:test"
import { captureImageResponse, coverRedirectUrl, parseCaptureImagePath } from "./capture-image"

const collection = "0xE95F98179a6365881aed0cb5331D96976E9Fe09b"

test("parses only canonical capture image paths", () => {
  assert.deepEqual(parseCaptureImagePath("11155111", collection, "26.png"), { chainId: 11155111, collection: collection.toLowerCase(), tokenId: "26" })
  for (const [chain, address, file] of [
    ["0", collection, "1.png"], ["1", "0x1234", "1.png"], ["1", collection, "01.png"],
    ["1", collection, "1.jpg"], ["1", collection, "1"], ["1", collection, "-1.png"], ["1e3", collection, "1.png"],
  ]) assert.equal(parseCaptureImagePath(chain, address, file), null, `${chain}/${address}/${file}`)
})

test("cover redirects through the Arweave gateway or to https only", () => {
  const id = "BBUEubbqaZ4AEhfczg9ciU2HkQA3LGHqFsCZRitrEJaX".slice(0, 43)
  assert.equal(coverRedirectUrl(`ar://${id}`), `https://arweave.net/${id}`)
  assert.equal(coverRedirectUrl(`ar://${id}/cover.png`), `https://arweave.net/${id}/cover.png`)
  assert.equal(coverRedirectUrl("https://example.com/cover.png"), "https://example.com/cover.png")
  for (const uri of [null, "", "ar://short", "http://example.com/c.png", "javascript:alert(1)", "data:image/png;base64,AA"]) {
    assert.equal(coverRedirectUrl(uri), null, String(uri))
  }
})

test("serves a rendered PNG as immutable, otherwise a short-lived cover redirect", async () => {
  const png = new Uint8Array([137, 80, 78, 71])
  const hosted = captureImageResponse({ png, sha256: "ab".repeat(32), cover_uri: "https://example.com/cover.png" })
  assert.equal(hosted.status, 200)
  assert.equal(hosted.headers.get("content-type"), "image/png")
  assert.match(hosted.headers.get("cache-control")!, /immutable/)
  assert.deepEqual(new Uint8Array(await hosted.arrayBuffer()), png)

  const pending = captureImageResponse({ png: null, sha256: null, cover_uri: "https://example.com/cover.png" })
  assert.equal(pending.status, 302)
  assert.equal(pending.headers.get("location"), "https://example.com/cover.png")
  assert.doesNotMatch(pending.headers.get("cache-control")!, /immutable/)

  assert.equal(captureImageResponse(undefined).status, 404, "unknown stream")
  assert.equal(captureImageResponse({ png: null, sha256: null, cover_uri: "ipfs://cover" }).status, 404)
})
