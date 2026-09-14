/**
 * Run with: node --experimental-strip-types --test apps/web/src/lib/create-collection-launch-link.test.ts
 *
 * Same runner convention as parseEthAmount.test.ts: Node's built-in test
 * runner + native TypeScript stripping, no test framework dependency.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { buildLaunchLink, parseLaunchLink } from "./create-collection-launch-link.ts"

function params(obj: Record<string, string>): URLSearchParams {
  return new URLSearchParams(obj)
}

test("prefills a full renderer launch link", () => {
  const { state, ignored } = parseLaunchLink(
    params({
      preset: "renderer",
      name: "Form of Solitude",
      symbol: "SOLITUDE",
      renderer: "0x800E140684591844C827E009e385cD461d9Ec920",
      supplyCap: "999",
      royaltyPct: "5",
      price: "0.001",
      payout: "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
    }),
  )
  assert.equal(ignored.length, 0)
  assert.equal(state.preset, "renderer")
  assert.equal(state.name, "Form of Solitude")
  assert.equal(state.symbol, "SOLITUDE")
  assert.equal(state.customRenderer, "0x800E140684591844C827E009e385cD461d9Ec920")
  assert.equal(state.supplyCap, "999")
  assert.equal(state.openSupply, false)
  assert.equal(state.royaltyPct, "5")
  assert.equal(state.priceRaw, "0.001")
  assert.equal(state.payout, "0xCB43078C32423F5348Cab5885911C3B5faE217F9")
})

test("renderer address implies preset=renderer when preset is absent", () => {
  const { state } = parseLaunchLink(params({ renderer: "0x800E140684591844C827E009e385cD461d9Ec920" }))
  assert.equal(state.preset, "renderer")
})

test("an explicit preset is not overridden by a renderer param", () => {
  const { state } = parseLaunchLink(
    params({ preset: "edition", renderer: "0x800E140684591844C827E009e385cD461d9Ec920" }),
  )
  assert.equal(state.preset, "edition")
})

test("generative is ignored, not applied", () => {
  const { state, ignored } = parseLaunchLink(params({ preset: "generative" }))
  assert.equal(state.preset, undefined)
  assert.equal(ignored.length, 1)
  assert.match(ignored[0], /generative/)
})

test("an unknown preset is ignored", () => {
  const { state, ignored } = parseLaunchLink(params({ preset: "bogus" }))
  assert.equal(state.preset, undefined)
  assert.equal(ignored.length, 1)
})

test("an invalid renderer address is dropped and listed", () => {
  const { state, ignored } = parseLaunchLink(params({ renderer: "notanaddress" }))
  assert.equal(state.customRenderer, undefined)
  assert.equal(state.preset, undefined)
  assert.equal(ignored.length, 1)
  assert.match(ignored[0], /renderer/)
})

test("an invalid payout address is dropped", () => {
  const { state, ignored } = parseLaunchLink(params({ payout: "0xnotanaddress" }))
  assert.equal(state.payout, undefined)
  assert.equal(ignored.length, 1)
})

test("a royalty outside 0-50 is dropped", () => {
  const { state, ignored } = parseLaunchLink(params({ royaltyPct: "75" }))
  assert.equal(state.royaltyPct, undefined)
  assert.equal(ignored.length, 1)
})

test("a non-positive or fractional supply cap is dropped", () => {
  for (const bad of ["0", "-5", "1.5", "abc"]) {
    const { state, ignored } = parseLaunchLink(params({ supplyCap: bad }))
    assert.equal(state.supplyCap, undefined, `expected ${bad} to be dropped`)
    assert.equal(ignored.length, 1)
  }
})

test("openSupply=1 sets openSupply true", () => {
  const { state, ignored } = parseLaunchLink(params({ openSupply: "1" }))
  assert.equal(state.openSupply, true)
  assert.equal(ignored.length, 0)
})

test("openSupply wins over a supplyCap given in the same link", () => {
  const { state } = parseLaunchLink(params({ supplyCap: "10", openSupply: "1" }))
  assert.equal(state.openSupply, true)
  assert.equal(state.supplyCap, "10")
})

test("a valid price is canonicalized via parseEthAmount", () => {
  const { state, ignored } = parseLaunchLink(params({ price: "0,5" }))
  assert.equal(state.priceRaw, "0.5")
  assert.equal(ignored.length, 0)
})

test("an invalid price is dropped and listed", () => {
  const { state, ignored } = parseLaunchLink(params({ price: "free" }))
  assert.equal(state.priceRaw, undefined)
  assert.equal(ignored.length, 1)
})

test("a mint window sets hasWindow and converts to local datetime strings", () => {
  const { state, ignored } = parseLaunchLink(
    params({ startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-11-01T00:00:00.000Z" }),
  )
  assert.equal(ignored.length, 0)
  assert.equal(state.hasWindow, true)
  assert.equal(typeof state.startAt, "string")
  assert.equal(typeof state.endAt, "string")
})

test("an end before start is rejected as a pair", () => {
  const { state, ignored } = parseLaunchLink(
    params({ startAt: "2026-11-01T00:00:00.000Z", endAt: "2026-10-01T00:00:00.000Z" }),
  )
  assert.equal(state.hasWindow, undefined)
  assert.equal(state.startAt, undefined)
  assert.equal(state.endAt, undefined)
  assert.equal(ignored.length, 1)
})

test("an unparseable date is dropped and listed", () => {
  const { state, ignored } = parseLaunchLink(params({ startAt: "not-a-date" }))
  assert.equal(state.startAt, undefined)
  assert.equal(state.hasWindow, undefined)
  assert.equal(ignored.length, 1)
})

test("collaborators parses unique valid addresses", () => {
  const a = "0xCB43078C32423F5348Cab5885911C3B5faE217F9"
  const b = "0x800E140684591844C827E009e385cD461d9Ec920"
  const { state, ignored } = parseLaunchLink(params({ collaborators: `${a},${b}` }))
  assert.deepEqual(state.collaborators, [{ address: a }, { address: b }])
  assert.equal(ignored.length, 0)
})

test("collaborators drops invalid entries and duplicates but keeps the rest", () => {
  const a = "0xCB43078C32423F5348Cab5885911C3B5faE217F9"
  const { state, ignored } = parseLaunchLink(params({ collaborators: `${a},notanaddress,${a}` }))
  assert.deepEqual(state.collaborators, [{ address: a }])
  assert.equal(ignored.length, 1)
})

test("an empty search yields no state and no ignored entries", () => {
  const { state, ignored } = parseLaunchLink(params({}))
  assert.deepEqual(state, {})
  assert.deepEqual(ignored, [])
})

// ─── buildLaunchLink ────────────────────────────────────────────────────────

test("buildLaunchLink + parseLaunchLink round-trips a full state", () => {
  const link = buildLaunchLink({
    preset: "edition",
    name: "Studies in Grey",
    symbol: "GREY",
    priceRaw: "0.05",
    openSupply: false,
    supplyCap: "250",
    royaltyPct: "7.5",
    payout: "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
    hasWindow: true,
    startAt: "2026-10-01T12:00",
    endAt: "2026-11-01T12:00",
    collaborators: [{ address: "0x800E140684591844C827E009e385cD461d9Ec920" }],
  })
  const { state, ignored } = parseLaunchLink(new URLSearchParams(link))
  assert.equal(ignored.length, 0)
  assert.equal(state.preset, "edition")
  assert.equal(state.name, "Studies in Grey")
  assert.equal(state.symbol, "GREY")
  assert.equal(state.priceRaw, "0.05")
  assert.equal(state.openSupply, false)
  assert.equal(state.supplyCap, "250")
  assert.equal(state.royaltyPct, "7.5")
  assert.equal(state.payout, "0xCB43078C32423F5348Cab5885911C3B5faE217F9")
  assert.equal(state.hasWindow, true)
  assert.deepEqual(state.collaborators, [{ address: "0x800E140684591844C827E009e385cD461d9Ec920" }])
})

test("buildLaunchLink omits fields with no meaningful value", () => {
  const link = buildLaunchLink({ name: "", symbol: "", collaborators: [] })
  assert.equal(link, "")
})

test("buildLaunchLink open supply omits supplyCap even if present", () => {
  const link = buildLaunchLink({ openSupply: true, supplyCap: "100" })
  const p = new URLSearchParams(link)
  assert.equal(p.get("openSupply"), "1")
  assert.equal(p.get("supplyCap"), null)
})
