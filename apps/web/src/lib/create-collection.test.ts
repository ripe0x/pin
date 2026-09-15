/**
 * Pure helpers behind the create wizard: the cover-URI validator, the
 * renderer address's sync/bytecode validation states, and the Review
 * step's summary builder.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  isValidArtworkURI,
  rendererAddressSyntax,
  hasBytecode,
  buildReviewSummary,
} from "./create-collection.ts"
import { initialWizardState, type WizardState } from "@/components/studio/create/types.ts"

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

test("rendererAddressSyntax: empty, invalid, valid", () => {
  assert.equal(rendererAddressSyntax(""), "empty")
  assert.equal(rendererAddressSyntax("   "), "empty")
  assert.equal(rendererAddressSyntax("not-an-address"), "invalid")
  assert.equal(rendererAddressSyntax("0x1111111111111111111111111111111111111111"), "valid")
})

test("hasBytecode: undefined/null/0x are no contract; any other code is a contract", () => {
  assert.equal(hasBytecode(undefined), false)
  assert.equal(hasBytecode(null), false)
  assert.equal(hasBytecode("0x"), false)
  assert.equal(hasBytecode("0x6080604052"), true)
})

function stateWith(overrides: Partial<WizardState>): WizardState {
  return { ...initialWizardState, ...overrides }
}

test("buildReviewSummary: renders every field with sensible fallbacks", () => {
  const state = stateWith({
    rendererAddress: "0x1111111111111111111111111111111111111111",
    name: "Studies in Grey",
    symbol: "GREY",
  })
  const rows = buildReviewSummary(state, "")
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]))
  assert.equal(byLabel["Renderer"], "0x1111111111111111111111111111111111111111")
  assert.equal(byLabel["Name"], "Studies in Grey")
  assert.equal(byLabel["Symbol"], "GREY")
  assert.equal(byLabel["Price"], "0 ETH (gas only)")
  assert.equal(byLabel["Supply"], "Open (no cap)")
  assert.equal(byLabel["Mint window"], "Open now, no end")
  assert.equal(byLabel["Royalty"], "10%")
  assert.equal(byLabel["Payout"], "You (connected wallet)")
  assert.equal(byLabel["Collaborators"], "None")
  assert.equal(byLabel["Cover image"], "None")
})

test("buildReviewSummary: a priced, capped collection with collaborators and a cover", () => {
  const state = stateWith({
    rendererAddress: "0x1111111111111111111111111111111111111111",
    name: "Studies in Grey",
    symbol: "GREY",
    openSupply: false,
    supplyCap: "10",
    payout: "0x2222222222222222222222222222222222222222",
    collaborators: [{ address: "0x3333333333333333333333333333333333333333" }],
    artworkURI: "ipfs://cover",
  })
  const rows = buildReviewSummary(state, "0.01")
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]))
  assert.equal(byLabel["Price"], "0.01 ETH")
  assert.equal(byLabel["Supply"], "10")
  assert.equal(byLabel["Payout"], "0x2222222222222222222222222222222222222222")
  assert.equal(byLabel["Collaborators"], "0x3333333333333333333333333333333333333333")
  assert.equal(byLabel["Cover image"], "ipfs://cover")
})
