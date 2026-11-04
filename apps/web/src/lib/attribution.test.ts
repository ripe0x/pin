/** Attribution roster rules (issue #261): v1 listing intersected with
 *  Catalog claims; v2 credits only the owner's own claim; a self-asserted
 *  Catalog claim by anyone else is never credited. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildAttributionRoster, creditedArtists, v2CreditableOwners } from "./attribution.ts"

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const C = "0xcccccccccccccccccccccccccccccccccccccccc"
const OWNER = "0x1111111111111111111111111111111111111111" as const
const STRANGER = "0x9999999999999999999999999999999999999999"
const ZERO = "0x0000000000000000000000000000000000000000"
const a = A.toLowerCase() as `0x${string}`

// ── v1 ──────────────────────────────────────────────────────────────────

test("v1: listed creators, confirmed only when they also claim", () => {
  const r = buildAttributionRoster({
    kind: "v1",
    listed: [
      { creator: A, listed: true },
      { creator: B, listed: true },
    ],
    claims: [a],
  })
  assert.equal(r.basis, "listed")
  assert.deepEqual(r.entries, [
    { creator: a, confirmed: true },
    { creator: B, confirmed: false },
  ])
})

test("v1: a claim without a listing is not credited", () => {
  const r = buildAttributionRoster({ kind: "v1", listed: [{ creator: A, listed: true }], claims: [a, C] })
  assert.deepEqual(r.entries, [{ creator: a, confirmed: true }])
})

test("v1: a removed (unlisted) creator drops out whatever their claim says", () => {
  const r = buildAttributionRoster({
    kind: "v1",
    listed: [
      { creator: A, listed: false },
      { creator: B, listed: true },
    ],
    claims: [a, B],
  })
  assert.deepEqual(r.entries, [{ creator: B, confirmed: true }])
})

test("v1: listing indexed but empty is an empty listed roster", () => {
  assert.deepEqual(buildAttributionRoster({ kind: "v1", listed: [], claims: [a] }), { basis: "listed", entries: [] })
})

test("v1 without collection_creators (ponder_v4): no roster, never a Catalog-only fallback", () => {
  const r = buildAttributionRoster({ kind: "v1", listed: null, claims: [A, STRANGER] })
  assert.deepEqual(r, { basis: "none", entries: [] })
  // ...so the byline falls back to the owner.
  assert.deepEqual(creditedArtists(r.entries, OWNER), [OWNER])
})

test("v1: addresses compare case-insensitively across the two sides", () => {
  const r = buildAttributionRoster({
    kind: "v1",
    listed: [{ creator: A, listed: true }],
    claims: [A.toUpperCase().replace("0X", "0x")],
  })
  assert.deepEqual(r.entries, [{ creator: a, confirmed: true }])
})

// ── primitive v2 ────────────────────────────────────────────────────────

test("v2: a stranger's claim is hidden (no roster entry, no byline credit)", () => {
  const r = buildAttributionRoster({ kind: "v2", claims: [STRANGER], owner: OWNER, launchOwner: OWNER })
  assert.deepEqual(r, { basis: "owner-claim", entries: [] })
  assert.deepEqual(creditedArtists(r.entries, OWNER), [OWNER])
})

test("v2: the owner's own claim is confirmed; other claims beside it stay hidden", () => {
  const r = buildAttributionRoster({
    kind: "v2",
    claims: [STRANGER, OWNER.toUpperCase().replace("0X", "0x"), C],
    owner: OWNER,
    launchOwner: OWNER,
  })
  assert.deepEqual(r.entries, [{ creator: OWNER, confirmed: true }])
  assert.deepEqual(creditedArtists(r.entries, OWNER), [OWNER])
})

test("v2: after an ownership transfer only the current owner's claim counts", () => {
  const r = buildAttributionRoster({ kind: "v2", claims: [a, B], owner: B, launchOwner: A })
  assert.deepEqual(r.entries, [{ creator: B, confirmed: true }])
})

test("v2 renounced: the launch owner's claim stands in for owner() == 0", () => {
  const r = buildAttributionRoster({ kind: "v2", claims: [STRANGER, a], owner: ZERO, launchOwner: A })
  assert.deepEqual(r.entries, [{ creator: a, confirmed: true }])
  assert.deepEqual(creditedArtists(r.entries, ZERO), [a])
})

test("v2 renounced with no launch owner on record: nothing credited", () => {
  assert.deepEqual(buildAttributionRoster({ kind: "v2", claims: [a], owner: ZERO, launchOwner: ZERO }).entries, [])
  assert.deepEqual(buildAttributionRoster({ kind: "v2", claims: [a], owner: ZERO, launchOwner: null }).entries, [])
})

test("v2CreditableOwners: live owner wins; zero never counts", () => {
  assert.deepEqual(v2CreditableOwners(OWNER, A), [OWNER])
  assert.deepEqual(v2CreditableOwners(ZERO, A), [a])
  assert.deepEqual(v2CreditableOwners(null, null), [])
  assert.deepEqual(v2CreditableOwners(ZERO, ZERO), [])
})

// ── byline ──────────────────────────────────────────────────────────────

test("creditedArtists: confirmed creators, else the owner", () => {
  assert.deepEqual(creditedArtists([], OWNER), [OWNER])
  assert.deepEqual(creditedArtists([{ creator: B, confirmed: false }], OWNER), [OWNER])
  assert.deepEqual(
    creditedArtists(
      [
        { creator: a, confirmed: true },
        { creator: B, confirmed: false },
      ],
      OWNER,
    ),
    [a],
  )
})
