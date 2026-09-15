/**
 * isValidArtworkURI / artworkRequired: the create wizard's cover-image
 * gate. Edition and a renderer preset resolving to DefaultRenderer (the
 * zero address included, since the factory substitutes it) must collect a
 * URI before Continue/Deploy enable; Generative and a genuine custom
 * renderer leave it optional.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { SEPOLIA_CHAIN_ID, MAINNET_CHAIN_ID } from "@pin/addresses"
import { artworkRequired, isDefaultRenderer, isValidArtworkURI } from "./create-collection.ts"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
// The real sepolia DefaultRenderer (packages/addresses/src/index.ts).
const SEPOLIA_DEFAULT_RENDERER = "0x29Ed24f394a794415A5545481842f0bb37a3bB93"
const CUSTOM_RENDERER = "0x1111111111111111111111111111111111111111"

test("isValidArtworkURI accepts ipfs/ar/https with content after the scheme", () => {
  assert.equal(isValidArtworkURI("ipfs://bafytest"), true)
  assert.equal(isValidArtworkURI("ar://abc123"), true)
  assert.equal(isValidArtworkURI("https://example.com/cover.png"), true)
})

test("isValidArtworkURI rejects empty, bare scheme, and other schemes", () => {
  assert.equal(isValidArtworkURI(""), false)
  assert.equal(isValidArtworkURI("ipfs://"), false)
  assert.equal(isValidArtworkURI("http://example.com"), false)
  assert.equal(isValidArtworkURI("not-a-uri"), false)
})

test("isValidArtworkURI trims surrounding whitespace", () => {
  assert.equal(isValidArtworkURI("  ipfs://bafytest  "), true)
})

test("isDefaultRenderer treats the zero address as DefaultRenderer", () => {
  assert.equal(isDefaultRenderer(ZERO_ADDRESS, SEPOLIA_CHAIN_ID), true)
})

test("isDefaultRenderer matches the configured DefaultRenderer address, case-insensitively", () => {
  assert.equal(isDefaultRenderer(SEPOLIA_DEFAULT_RENDERER, SEPOLIA_CHAIN_ID), true)
  assert.equal(isDefaultRenderer(SEPOLIA_DEFAULT_RENDERER.toLowerCase(), SEPOLIA_CHAIN_ID), true)
})

test("isDefaultRenderer is false for a genuine custom renderer", () => {
  assert.equal(isDefaultRenderer(CUSTOM_RENDERER, SEPOLIA_CHAIN_ID), false)
})

test("artworkRequired: Edition always requires artwork", () => {
  assert.equal(artworkRequired("edition", "", SEPOLIA_CHAIN_ID), true)
})

test("artworkRequired: Generative never requires artwork", () => {
  assert.equal(artworkRequired("generative", "", SEPOLIA_CHAIN_ID), false)
})

test("artworkRequired: Renderer preset with the zero address (DefaultRenderer) requires artwork", () => {
  assert.equal(artworkRequired("renderer", ZERO_ADDRESS, SEPOLIA_CHAIN_ID), true)
})

test("artworkRequired: Renderer preset with a genuine custom renderer does not require artwork", () => {
  assert.equal(artworkRequired("renderer", CUSTOM_RENDERER, SEPOLIA_CHAIN_ID), false)
})

test("artworkRequired: Renderer preset with no DefaultRenderer configured for the chain falls back to not required", () => {
  // MAINNET_CHAIN_ID has no DefaultRenderer deployed yet (zero address in
  // packages/addresses), so only the zero-address customRenderer counts.
  assert.equal(artworkRequired("renderer", CUSTOM_RENDERER, MAINNET_CHAIN_ID), false)
})
