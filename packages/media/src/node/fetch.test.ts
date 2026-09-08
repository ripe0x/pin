import assert from "node:assert/strict"
import test from "node:test"
import { UnsupportedMediaError, isPrivateIp, resolvePublicHttpUrl } from "./fetch.ts"

test("isPrivateIp flags loopback and link-local addresses", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true)
  assert.equal(isPrivateIp("169.254.169.254"), true)
  assert.equal(isPrivateIp("10.0.0.5"), true)
  assert.equal(isPrivateIp("8.8.8.8"), false)
})

test("resolvePublicHttpUrl rejects a non-http(s) scheme", async () => {
  await assert.rejects(resolvePublicHttpUrl("ftp://example.test/file"), UnsupportedMediaError)
})

test("resolvePublicHttpUrl rejects a literal loopback or metadata-service address", async () => {
  await assert.rejects(resolvePublicHttpUrl("http://127.0.0.1/x"), /non-public media host rejected/)
  await assert.rejects(resolvePublicHttpUrl("http://169.254.169.254/x"), /non-public media host rejected/)
})

test("resolvePublicHttpUrl rejects localhost once resolved", async () => {
  await assert.rejects(resolvePublicHttpUrl("http://localhost/x"), /non-public media host rejected/)
})
