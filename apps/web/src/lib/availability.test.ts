import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  NO_AVAILABILITY_TABLES,
  galleryOrderBySql,
  loadAvailabilityTables,
  parseGallerySort,
  pgTextArray,
  rankRefsByAvailability,
  saleStateForKeysSql,
  saleStateMap,
  saleStateSql,
  type AvailabilityTables,
} from "./availability.ts"

const flat = (s: string) => s.replace(/\s+/g, " ").trim()
const ALL: AvailabilityTables = {
  pndAuctions: true,
  pndListingExpiry: true,
  fndAuctions: true,
  fndBuyNows: true,
  srv2: true,
  tl: true,
}

// Refs in discovery order (newest mint first), like discoverArtistTokenRefs.
const refs = ["9", "8", "7", "6", "5", "4", "3", "2", "1"].map((id) => ({
  contract: "0xC",
  tokenId: id,
}))

test("sort param defaults to availability; only 'newest' switches it", () => {
  assert.equal(parseGallerySort(undefined), "availability")
  assert.equal(parseGallerySort(null), "availability")
  assert.equal(parseGallerySort("bogus"), "availability")
  assert.equal(parseGallerySort("newest"), "newest")
})

test("availability: live auctions (ending soonest first), then listed, then the rest by recency", () => {
  const sale = saleStateMap([
    { contract: "0xc", token_id: "1", sale_rank: 0, source: "pnd", ends_at: 2_000 },   // oldest token, live
    { contract: "0xc", token_id: "5", sale_rank: 0, source: "srv2", ends_at: 1_000 },  // ends sooner
    { contract: "0xc", token_id: "7", sale_rank: 0, source: "fnd-auction", ends_at: null }, // reserve, no bids
    { contract: "0xc", token_id: "2", sale_rank: 1, source: "fnd-buy-now", ends_at: null },
    { contract: "0xc", token_id: "6", sale_rank: "1", source: "tl-buy-now", ends_at: null },
  ])
  const ranked = rankRefsByAvailability(refs, sale).map((r) => r.tokenId)
  assert.deepEqual(ranked, ["5", "1", "7", "6", "2", "9", "8", "4", "3"])
})

test("an active listing on the oldest token lands on page one", () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ contract: "0xc", tokenId: String(500 - i) }))
  const sale = saleStateMap([{ contract: "0xc", token_id: "1", sale_rank: 1, source: "fnd-buy-now", ends_at: null }])
  const pageOne = rankRefsByAvailability(many, sale).slice(0, 24)
  assert.equal(pageOne[0].tokenId, "1")
  assert.equal(pageOne[1].tokenId, "500", "the rest keep mint recency")
})

test("newest (or no sale state) keeps discovery order and never mutates input", () => {
  const sale = saleStateMap([{ contract: "0xc", token_id: "1", sale_rank: 0, source: "pnd", ends_at: 1 }])
  const input = refs.slice()
  assert.deepEqual(rankRefsByAvailability(input, sale, "newest"), refs)
  assert.deepEqual(rankRefsByAvailability(input, new Map()), refs)
  rankRefsByAvailability(input, sale)
  assert.deepEqual(input, refs)
})

test("SQL order matches the JS ranker and ends on a unique tiebreak", () => {
  assert.equal(
    flat(galleryOrderBySql("availability")),
    "COALESCE(s.sale_rank, 2), s.ends_at ASC NULLS LAST, r.mint_block DESC, r.mint_log_index DESC, r.contract, r.token_id",
  )
  assert.equal(
    flat(galleryOrderBySql("newest")),
    "r.mint_block DESC, r.mint_log_index DESC, r.contract, r.token_id",
  )
})

test("sale state only reads the sources that exist", () => {
  const none = flat(saleStateSql("ponder_v4", NO_AVAILABILITY_TABLES, "refs"))
  assert.match(none, /WHERE false$/)
  const onlySr = flat(saleStateSql("ponder_v4", { ...NO_AVAILABILITY_TABLES, srv2: true }, "refs"))
  assert.match(onlySr, /srv2_active_auctions/)
  assert.doesNotMatch(onlySr, /pnd_auctions|fnd_|tl_active/)
  const all = flat(saleStateSql("ponder_v4", ALL, "refs"))
  for (const t of ["ponder_v4.pnd_auctions", "ponder_v4.fnd_auctions", "ponder_v4.fnd_buy_nows", "srv2_active_auctions", "tl_active_auctions"]) {
    assert.ok(all.includes(t), t)
  }
  // Without V2's column the expiry guard is left out (older schemas).
  assert.doesNotMatch(flat(saleStateSql("ponder_v4", { ...ALL, pndListingExpiry: false }, "refs")), /listing_expiry/)
})

test("stale trackers and ended auctions are never live", () => {
  const all = flat(saleStateSql("ponder_v4", ALL, "refs"))
  assert.match(all, /s\.updated_at > NOW\(\) - interval '30 minutes'/)
  assert.match(all, /t\.updated_at > NOW\(\) - interval '30 minutes'/)
  assert.match(all, /a\.end_time = 0 OR a\.end_time > EXTRACT\(EPOCH FROM NOW\(\)\)::bigint/)
  assert.match(all, /a\.listing_expiry <= EXTRACT\(EPOCH FROM NOW\(\)\)::bigint/)
  // Joins stay on the indexed (contract, token_id) columns.
  assert.match(all, /a\.token_contract = r\.contract AND a\.token_id = r\.token_id::numeric/)
  // A token in two sources keeps its best rank.
  assert.match(all, /DISTINCT ON \(x\.contract, x\.token_id\).*ORDER BY x\.contract, x\.token_id, x\.sale_rank, x\.ends_at NULLS LAST/)
})

test("names are validated before being inlined", () => {
  assert.throws(() => saleStateSql("ponder_v4; DROP", ALL, "refs"))
  assert.throws(() => saleStateSql("ponder_v4", ALL, "refs r; --"))
  assert.match(flat(saleStateForKeysSql("ponder_v4", ALL)), /unnest\(\$1::text\[\], \$2::text\[\]\)/)
})

test("pgTextArray quotes and escapes", () => {
  assert.equal(pgTextArray([]), "{}")
  assert.equal(pgTextArray(["0xa", "1"]), '{"0xa","1"}')
  assert.equal(pgTextArray(['a"b', "c\\d"]), '{"a\\"b","c\\\\d"}')
})

test("table existence is checked once per schema and cached", async () => {
  let calls = 0
  const sql = {
    unsafe: async (_q: string, params?: Array<string | number>) => {
      calls++
      assert.deepEqual(params?.slice(0, 3), ["test_schema.pnd_auctions", "test_schema.fnd_auctions", "test_schema.fnd_buy_nows"])
      return [{ pnd_auctions: true, pnd_listing_expiry: true, fnd_auctions: false, fnd_buy_nows: true, srv2: true, tl: false }]
    },
  }
  const t1 = await loadAvailabilityTables(sql, "test_schema", 0)
  assert.deepEqual(t1, { pndAuctions: true, pndListingExpiry: true, fndAuctions: false, fndBuyNows: true, srv2: true, tl: false })
  await loadAvailabilityTables(sql, "test_schema", 60_000)
  assert.equal(calls, 1)
  await loadAvailabilityTables(sql, "test_schema", 11 * 60_000)
  assert.equal(calls, 2)
})
