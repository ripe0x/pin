import { strict as assert } from "node:assert"
import { test } from "node:test"
import type { Address } from "viem"
import {
  ESCAPE_DOCUMENT_CSP,
  escapeArtworkPath,
  resolveEscapeTarget,
  type EscapeResolveDeps,
} from "./escape-resolve.ts"

const COLLECTION = "0xb741055bd0467a5831b8b5f7df376cda93a76af1"
const RENDERER = "0x538ffa56d568dfb373baf15d099e610b4a9a00d5"
const OTHER = "0x1111111111111111111111111111111111111111"

function deps(overrides: Partial<EscapeResolveDeps> = {}): EscapeResolveDeps {
  return {
    defaultCollection: "0xb741055BD0467a5831B8B5f7DF376cdA93a76af1",
    getCollection: async (a: Address) =>
      a.toLowerCase() === COLLECTION ? { renderer: "0x538ffA56d568Dfb373Baf15d099E610b4a9a00D5", minted: 5n } : null,
    isEscapeRenderer: async (r: Address) => r.toLowerCase() === RENDERER,
    tokenExists: async () => false,
    ...overrides,
  }
}

test("resolves the renderer from the collection, never the request", async () => {
  assert.deepEqual(
    await resolveEscapeTarget({ tokenId: "3", collection: COLLECTION, renderer: null }, deps()),
    { collection: COLLECTION, renderer: RENDERER, tokenId: 3n },
  )
  // Default collection when none is named.
  assert.deepEqual(
    await resolveEscapeTarget({ tokenId: "1", collection: null, renderer: null }, deps()),
    { collection: COLLECTION, renderer: RENDERER, tokenId: 1n },
  )
})

test("a renderer param is accepted only when it equals the collection's renderer", async () => {
  assert.notEqual(
    await resolveEscapeTarget({ tokenId: "1", collection: null, renderer: RENDERER.toUpperCase().replace("0X", "0x") }, deps()),
    null,
  )
  assert.equal(
    await resolveEscapeTarget({ tokenId: "1", collection: null, renderer: OTHER }, deps()),
    null,
  )
})

test("unknown collections and non-escape renderers resolve to null", async () => {
  assert.equal(
    await resolveEscapeTarget({ tokenId: "1", collection: OTHER, renderer: null }, deps()),
    null,
  )
  assert.equal(
    await resolveEscapeTarget(
      { tokenId: "1", collection: COLLECTION, renderer: null },
      deps({ isEscapeRenderer: async () => false }),
    ),
    null,
  )
  assert.equal(
    await resolveEscapeTarget({ tokenId: "1", collection: "not-an-address", renderer: null }, deps()),
    null,
  )
  assert.equal(
    await resolveEscapeTarget({ tokenId: "1", collection: null, renderer: null }, deps({ defaultCollection: null })),
    null,
  )
})

test("token ids are bounded by minted count unless the token exists", async () => {
  assert.equal(await resolveEscapeTarget({ tokenId: "0", collection: null, renderer: null }, deps()), null)
  assert.equal(await resolveEscapeTarget({ tokenId: "6", collection: null, renderer: null }, deps()), null)
  assert.equal(await resolveEscapeTarget({ tokenId: "abc", collection: null, renderer: null }, deps()), null)
  assert.equal(await resolveEscapeTarget({ tokenId: "9".repeat(80), collection: null, renderer: null }, deps()), null)
  let asked: bigint | null = null
  const r = await resolveEscapeTarget(
    { tokenId: "99", collection: null, renderer: null },
    deps({
      tokenExists: async (_c, id) => {
        asked = id
        return true
      },
    }),
  )
  assert.equal(asked, 99n)
  assert.notEqual(r, null)
})

test("token 1 previews before any mint", async () => {
  const preMint = deps({
    getCollection: async () => ({ renderer: RENDERER, minted: 0n }),
  })
  assert.notEqual(await resolveEscapeTarget({ tokenId: "1", collection: null, renderer: null }, preMint), null)
  assert.equal(await resolveEscapeTarget({ tokenId: "2", collection: null, renderer: null }, preMint), null)
})

test("artwork path names the collection, and the CSP keeps the document sandboxed", () => {
  assert.equal(
    escapeArtworkPath(4n, "0xB741055BD0467a5831B8B5f7DF376cdA93a76af1"),
    `/api/escape/4?collection=${COLLECTION}`,
  )
  assert.match(ESCAPE_DOCUMENT_CSP, /^sandbox allow-scripts;/)
  assert.match(ESCAPE_DOCUMENT_CSP, /default-src 'none'/)
  assert.match(ESCAPE_DOCUMENT_CSP, /connect-src data: blob: https:\/\/arweave\.net https:\/\/\*\.arweave\.net/)
  assert.doesNotMatch(ESCAPE_DOCUMENT_CSP, /allow-same-origin/)
})
