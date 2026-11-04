/** Preservation card fact model (issue #265): storage classification and
 *  the v1 / primitive v2 fact matrix, including unknown-storage honesty. */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  classifyArt,
  classifyStorage,
  describeStorage,
  isFullyOnchain,
  preservationFacts,
  type PreservationInput,
} from "./preservation.ts"

test("classifyStorage: data: of any type is onchain", () => {
  assert.equal(classifyStorage("data:application/json;base64,eyJ9"), "onchain")
  assert.equal(classifyStorage("data:image/svg+xml;base64,PHN2Zz4="), "onchain")
  assert.equal(classifyStorage("data:text/html;base64,PGh0bWw+"), "onchain")
  assert.equal(classifyStorage("DATA:audio/mp3;base64,AAAA"), "onchain")
})

test("classifyStorage: IPFS, Arweave, web servers, unknown", () => {
  assert.equal(classifyStorage("ipfs://bafy123/1.json"), "ipfs")
  assert.equal(classifyStorage("https://ipfs.io/ipfs/bafy123"), "ipfs")
  assert.equal(classifyStorage("https://bafy123.ipfs.nftstorage.link/"), "ipfs")
  assert.equal(classifyStorage("ar://abc"), "arweave")
  assert.equal(classifyStorage("https://arweave.net/abc"), "arweave")
  assert.equal(classifyStorage("https://api.example.com/token/1"), "web")
  assert.equal(classifyStorage("http://example.com/1.png"), "web")
  assert.equal(classifyStorage(""), "unknown")
  assert.equal(classifyStorage(null), "unknown")
  assert.equal(classifyStorage("/api/escape/1"), "unknown")
})

test("classifyArt + describeStorage: fully onchain generative work", () => {
  const s = classifyArt({
    tokenUri: "data:application/json;base64,e30=",
    image: "data:image/svg+xml;base64,PHN2Zz4=",
    animationUrl: "data:text/html;base64,PGh0bWw+",
  })
  assert.equal(isFullyOnchain(s), true)
  assert.equal(describeStorage(s), "Fully onchain")
})

test("classifyArt + describeStorage: onchain metadata pointing at IPFS media", () => {
  const s = classifyArt({ tokenUri: "data:application/json;base64,e30=", image: "ipfs://bafy/1.png" })
  assert.equal(isFullyOnchain(s), false)
  assert.equal(describeStorage(s), "Metadata onchain, image on IPFS")
})

test("describeStorage: image and animation named separately when they differ, once when equal", () => {
  const mixed = classifyArt({
    tokenUri: "https://api.example.com/1",
    image: "https://arweave.net/x",
    animationUrl: "ipfs://bafy/anim.html",
  })
  assert.equal(describeStorage(mixed), "Metadata on a web server, image on Arweave, animation on IPFS")
  const same = classifyArt({ tokenUri: "ipfs://a", image: "ipfs://b", animationUrl: "ipfs://c" })
  assert.equal(describeStorage(same), "Metadata on IPFS, media on IPFS")
})

test("onchain metadata with no media is not called fully onchain", () => {
  const s = classifyArt({ tokenUri: "data:application/json;base64,e30=" })
  assert.equal(isFullyOnchain(s), false)
  assert.equal(describeStorage(s), "Metadata onchain")
})

test("unreadable metadata is said plainly, never assumed onchain", () => {
  const s = classifyArt({ tokenUri: null, image: "ipfs://x" })
  assert.equal(describeStorage(s), "Metadata not determined, image on IPFS")
})

test("assembled (escape): FOC mode is onchain; hi-res shares the still's Arweave dependency", () => {
  const foc = classifyArt({ image: "data:image/gif;base64,R0lG", assembled: { focMode: true } })
  assert.equal(describeStorage(foc), "Fully onchain")
  const hires = classifyArt({ image: "https://arweave.net/still", assembled: { focMode: false } })
  assert.equal(describeStorage(hires), "Metadata onchain, media on Arweave")
})

const v1: PreservationInput = {
  primitiveV2: false,
  protocolVersion: 1,
  isRendererLocked: false,
  isSupplyLocked: false,
  isRoyaltyLocked: false,
  sealed: false,
  supplyCap: 0n,
  saleClosed: false,
  storage: null,
  muri: null,
}
const byLabel = (facts: ReturnType<typeof preservationFacts>) => Object.fromEntries(facts.map((f) => [f.label, f]))

test("v1 unlocked: every lock reads as changeable", () => {
  const f = byLabel(preservationFacts(v1))
  assert.deepEqual(Object.keys(f), ["Renderer", "Supply", "Royalty"])
  assert.equal(f.Renderer.value, "Owner can change")
  assert.equal(f.Renderer.tone, "open")
  assert.equal(f.Supply.value, "Owner can change")
  assert.equal(f.Royalty.value, "Owner can change")
})

test("v1 locked: renderer and supply locked; royalty stays changeable (no v1 royalty lock)", () => {
  const f = byLabel(
    preservationFacts({ ...v1, isRendererLocked: true, isSupplyLocked: true, isRoyaltyLocked: true, supplyCap: 100n }),
  )
  assert.equal(f.Renderer.value, "Locked")
  assert.equal(f.Renderer.tone, "fixed")
  assert.equal(f.Supply.value, "Locked at 100")
  assert.equal(f.Royalty.value, "Owner can change")
})

test("superseded SurfaceV2 (protocolVersion 2, not primitive): royalty lock is real", () => {
  const f = byLabel(preservationFacts({ ...v1, protocolVersion: 2, isRoyaltyLocked: true }))
  assert.equal(f.Royalty.value, "Locked")
})

test("art data: fixed only when fully onchain AND the renderer cannot change", () => {
  const onchain = classifyArt({ tokenUri: "data:application/json,{}", image: "data:image/png;base64,AA" })
  assert.equal(byLabel(preservationFacts({ ...v1, storage: onchain }))["Art data"].tone, "info")
  const locked = byLabel(preservationFacts({ ...v1, storage: onchain, isRendererLocked: true }))
  assert.equal(locked["Art data"].tone, "fixed")
  assert.equal(locked["Art data"].value, "Fully onchain")
  const sampled = byLabel(preservationFacts({ ...v1, storage: onchain, storageSample: "token #1" }))
  assert.equal(sampled["Art data"].value, "Fully onchain (token #1)")
})

test("primitive v2 held: ownership open, no v1 lock rows", () => {
  const f = byLabel(preservationFacts({ ...v1, primitiveV2: true, protocolVersion: 2 }))
  assert.deepEqual(Object.keys(f), ["Ownership", "Supply"])
  assert.equal(f.Ownership.tone, "open")
  assert.equal(f.Supply.value, "No cap set, sale open")
  assert.equal(f.Supply.tone, "open")
})

test("primitive v2 renounced with a cap and a closed sale", () => {
  const f = byLabel(
    preservationFacts({ ...v1, primitiveV2: true, protocolVersion: 2, sealed: true, supplyCap: 50n, saleClosed: true }),
  )
  assert.equal(f.Ownership.value, "Renounced, nothing can change")
  assert.equal(f.Ownership.tone, "fixed")
  assert.equal(f.Supply.value, "Capped at 50, sale closed")
  assert.equal(f.Supply.tone, "fixed")
})

test("primitive v2: sale closed without a cap", () => {
  const f = byLabel(preservationFacts({ ...v1, primitiveV2: true, protocolVersion: 2, saleClosed: true }))
  assert.equal(f.Supply.value, "Sale closed")
  assert.equal(f.Supply.tone, "info")
})

test("MURI: v1 only, only when the data says so", () => {
  assert.equal(byLabel(preservationFacts({ ...v1, muri: { registered: false, tokens: 0 } })).MURI, undefined)
  assert.equal(byLabel(preservationFacts({ ...v1, muri: { registered: true, tokens: 0 } })).MURI.value, "Registered, no tokens anchored yet")
  assert.equal(byLabel(preservationFacts({ ...v1, muri: { registered: true, tokens: 3 } })).MURI.value, "3 tokens anchored")
  assert.equal(byLabel(preservationFacts({ ...v1, muri: { registered: false, tokens: 1 } })).MURI.value, "1 token anchored")
  assert.equal(
    byLabel(preservationFacts({ ...v1, primitiveV2: true, muri: { registered: true, tokens: 3 } })).MURI,
    undefined,
  )
  assert.equal(byLabel(preservationFacts({ ...v1, muri: { registered: false, tokens: 1 }, muriScope: "token" })).MURI.value, "Anchored")
  assert.equal(byLabel(preservationFacts({ ...v1, muri: { registered: false, tokens: 0 }, muriScope: "token" })).MURI, undefined)
})

test("copy rules: no em dashes, onchain is one word", () => {
  const all = [
    ...preservationFacts({ ...v1, storage: classifyArt({ tokenUri: "data:,", image: "ipfs://x" }), muri: { registered: true, tokens: 2 } }),
    ...preservationFacts({ ...v1, primitiveV2: true, sealed: true, supplyCap: 1n, saleClosed: true }),
  ]
  for (const f of all) {
    assert.ok(!/—/.test(f.value + f.label), f.value)
    assert.ok(!/on-chain|on chain/i.test(f.value), f.value)
  }
})
