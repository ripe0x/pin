import assert from "node:assert/strict"
import test from "node:test"
import { decodeInlineMedia } from "./inline-media"

test("decodes allowed base64 image data", () => {
  const decoded = decodeInlineMedia("data:image/png;base64,aGVsbG8=")

  assert.equal(decoded?.contentType, "image/png")
  assert.equal(Buffer.from(decoded?.body ?? []).toString("utf8"), "hello")
})

test("decodes percent encoded image data", () => {
  const decoded = decodeInlineMedia("data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E")

  assert.equal(decoded?.contentType, "image/svg+xml")
  assert.equal(Buffer.from(decoded?.body ?? []).toString("utf8"), "<svg></svg>")
})

test("rejects unsupported, malformed, empty, and oversized data", () => {
  assert.equal(decodeInlineMedia("data:text/html;base64,aGVsbG8="), null)
  assert.equal(decodeInlineMedia("not-a-data-uri"), null)
  assert.equal(decodeInlineMedia("data:image/png;base64,"), null)
  assert.equal(
    decodeInlineMedia(`data:image/png;base64,${"a".repeat(7 * 1024 * 1024)}`),
    null,
  )
})
