import { strict as assert } from "node:assert"
import { test } from "node:test"
import { fetchMetadataForUri } from "./index.ts"

test("metadata fetch rejects insecure and private-network URLs", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error("must not fetch")
  }
  try {
    assert.equal(await fetchMetadataForUri("http://example.com/meta", 1n), null)
    assert.equal(await fetchMetadataForUri("https://127.0.0.1/meta", 1n), null)
    assert.equal(await fetchMetadataForUri("https://169.254.169.254/meta", 1n), null)
    assert.equal(await fetchMetadataForUri("https://[::ffff:7f00:1]/meta", 1n), null)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("metadata redirects are revalidated before following", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/internal" },
    })
  }
  try {
    assert.equal(await fetchMetadataForUri("https://8.8.8.8/meta", 1n), null)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("metadata responses are capped before JSON parsing", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('{"name":"too large"}', {
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024 + 1),
      },
    })
  try {
    assert.equal(await fetchMetadataForUri("https://8.8.8.8/meta", 1n), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("valid public HTTPS metadata still resolves", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('{"name":"Public work","image":"ipfs://example"}', {
      headers: { "content-type": "application/json" },
    })
  try {
    assert.deepEqual(await fetchMetadataForUri("https://8.8.8.8/meta", 1n), {
      name: "Public work",
      image: "ipfs://example",
      uri: "https://8.8.8.8/meta",
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("oversized inline metadata is rejected", async () => {
  const uri = `data:application/json,{"name":"${"x".repeat(2 * 1024 * 1024)}"}`
  assert.equal(await fetchMetadataForUri(uri, 1n), null)
})
