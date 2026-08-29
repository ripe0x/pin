import assert from "node:assert/strict"
import test from "node:test"
import { decodeInlineMedia } from "./inline-media"

test("decodes base64 image data", () => {
  const decoded = decodeInlineMedia("data:image/gif;base64,R0lGODlh")
  assert.equal(decoded?.contentType, "image/gif")
  assert.equal(Buffer.from(decoded?.body ?? []).toString("ascii"), "GIF89a")
})

test("decodes percent-encoded SVG data", () => {
  const decoded = decodeInlineMedia("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")
  assert.equal(decoded?.contentType, "image/svg+xml")
  assert.equal(Buffer.from(decoded?.body ?? []).toString(), "<svg></svg>")
})

test("rejects executable and malformed data", () => {
  assert.equal(decodeInlineMedia("data:text/html,<script>x</script>"), null)
  assert.equal(decodeInlineMedia("https://example.com/art.png"), null)
})
