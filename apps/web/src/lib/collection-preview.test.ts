import { test } from "node:test"
import assert from "node:assert/strict"
import { decodePreviewURI } from "./collection-preview.ts"

test("decodePreviewURI: unsupported for a non-data-URI string", () => {
  assert.deepEqual(decodePreviewURI("not a uri"), { kind: "unsupported" })
})

test("decodePreviewURI: unsupported for JSON metadata with no image/animation_url", () => {
  const json = JSON.stringify({ name: "preview" })
  const uri = `data:application/json;base64,${btoa(json)}`
  assert.deepEqual(decodePreviewURI(uri), { kind: "unsupported" })
})

test("decodePreviewURI: image field decodes as an image preview", () => {
  const json = JSON.stringify({ name: "preview", image: "data:image/png;base64,AAAA" })
  const uri = `data:application/json;base64,${btoa(json)}`
  assert.deepEqual(decodePreviewURI(uri), { kind: "image", src: "data:image/png;base64,AAAA" })
})

test("decodePreviewURI: an inline data:text/html animation_url decodes as html", () => {
  const html = "<html><body>hi</body></html>"
  const animation = `data:text/html;base64,${btoa(html)}`
  const json = JSON.stringify({ name: "preview", animation_url: animation, image: "ignored" })
  const uri = `data:application/json;base64,${btoa(json)}`
  assert.deepEqual(decodePreviewURI(uri), { kind: "html", html })
})

test("decodePreviewURI: a non-base64 data:application/json URI also decodes", () => {
  const json = encodeURIComponent(JSON.stringify({ image: "ipfs://bafytest" }))
  const uri = `data:application/json,${json}`
  assert.deepEqual(decodePreviewURI(uri), { kind: "image", src: "ipfs://bafytest" })
})
