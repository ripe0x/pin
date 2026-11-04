import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  DEFAULT_HOLDINGS_LIMIT, MAX_HOLDINGS_LIMIT, afterCursor, clampHoldingsLimit,
  collectorHoldingsParams, collectorHoldingsSql, cursorAfter, decodeHoldingCursor,
  dedupeAndSortHoldings, encodeHoldingCursor, type HoldingRow,
} from "./collector-holdings.ts"

const C1 = "0x1111111111111111111111111111111111111111"
const C2 = "0x2222222222222222222222222222222222222222"
const SURF = "0x5555555555555555555555555555555555555555"

const row = (contract: string, token_id: string, block: number, source: HoldingRow["source"], balance = "1"): HoldingRow => ({
  contract, token_id, block: String(block), source, balance,
  standard: source === "erc1155_balances" ? "erc1155" : "erc721",
})

/** Walk every page the way the API does: limit + 1 rows, cursor = last row. */
function paginate(rows: HoldingRow[], limit: number): HoldingRow[][] {
  const all = dedupeAndSortHoldings(rows)
  const pages: HoldingRow[][] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 100; guard++) {
    const slice = afterCursor(all, decodeHoldingCursor(cursor)).slice(0, limit + 1)
    const page = slice.slice(0, limit)
    pages.push(page)
    if (slice.length <= limit) break
    cursor = cursorAfter(page[page.length - 1])
  }
  return pages
}

test("cursor round-trips and rejects anything it didn't produce", () => {
  const c = { block: 25_000_123n, contract: C1, tokenId: "42" }
  assert.deepEqual(decodeHoldingCursor(encodeHoldingCursor(c)), c)
  assert.equal(decodeHoldingCursor(null), null)
  assert.equal(decodeHoldingCursor(""), null)
  assert.equal(decodeHoldingCursor("not base64!"), null)
  assert.equal(decodeHoldingCursor(Buffer.from("1:0xabc:2").toString("base64url")), null)
  assert.equal(decodeHoldingCursor(Buffer.from(`1:${C1}:-2`).toString("base64url")), null)
  assert.equal(decodeHoldingCursor(Buffer.from(`1:${C1}:2:x`).toString("base64url")), null)
})

test("limit is clamped", () => {
  assert.equal(clampHoldingsLimit(undefined), DEFAULT_HOLDINGS_LIMIT)
  assert.equal(clampHoldingsLimit(""), DEFAULT_HOLDINGS_LIMIT)
  assert.equal(clampHoldingsLimit("abc"), DEFAULT_HOLDINGS_LIMIT)
  assert.equal(clampHoldingsLimit("0"), 1)
  assert.equal(clampHoldingsLimit(10_000), MAX_HOLDINGS_LIMIT)
  assert.equal(clampHoldingsLimit("7.9"), 7)
})

test("one row per token: Surface beats 1155 beats token_owners", () => {
  const out = dedupeAndSortHoldings([
    row(SURF, "1", 10, "token_owners"), // stale block-0 style row from another writer
    row(SURF, "1", 50, "surface"),
    row(C2, "3", 20, "token_owners"),
    row(C2, "3", 30, "erc1155_balances", "4"),
  ])
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((r) => r.source), ["surface", "erc1155_balances"])
  assert.equal(out[1].balance, "4")
})

test("order is newest block first, then contract and token id descending, bytewise", () => {
  const out = dedupeAndSortHoldings([
    row(C1, "9", 100, "token_owners"),
    row(C1, "10", 100, "token_owners"),
    row(C2, "1", 100, "token_owners"),
    row(C1, "1", 0, "token_owners"),
    row(C1, "2", 500, "erc1155_balances"),
  ])
  assert.deepEqual(out.map((r) => `${r.block}:${r.contract.slice(0, 4)}:${r.token_id}`), [
    "500:0x11:2", "100:0x22:1", "100:0x11:9", "100:0x11:10", "0:0x11:1",
  ])
})

test("pages cover every holding exactly once, with ties on block", () => {
  const rows: HoldingRow[] = []
  for (let i = 0; i < 23; i++) rows.push(row(i % 2 ? C1 : C2, String(i), 100 + (i % 3), "token_owners"))
  rows.push(row(C1, "5", 999, "erc1155_balances", "2")) // duplicate key, higher precedence
  const pages = paginate(rows, 5)
  const flat = pages.flat()
  assert.equal(flat.length, 23)
  assert.equal(new Set(flat.map((r) => `${r.contract}:${r.token_id}`)).size, 23)
  assert.deepEqual(flat, dedupeAndSortHoldings(rows))
  assert.deepEqual(pages.map((p) => p.length), [5, 5, 5, 5, 3])
})

test("an exact multiple of the page size ends without an empty extra page", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(C1, String(i), i, "token_owners"))
  assert.deepEqual(paginate(rows, 5).map((p) => p.length), [5, 5])
})

test("SQL: sources are optional and guarded, keyset matches the JS order", () => {
  const bare = collectorHoldingsSql("ponder_v4", { surface: false, erc1155: false })
  assert.doesNotMatch(bare, /collection_tokens|token_1155/)
  assert.match(bare, /FROM token_owners o\s+WHERE o\.owner = \$1/)

  const full = collectorHoldingsSql("ponder_v5", { surface: true, erc1155: true })
  assert.match(full, /ponder_v5\.collection_tokens ct\s+WHERE ct\.owner = \$1/)
  assert.match(full, /token_1155_balances b\s+WHERE b\.holder = \$1 AND b\.balance > 0/)
  assert.match(full, /NOT EXISTS \(SELECT 1 FROM token_1155_transfers x WHERE x\.contract = o\.contract\)/)
  assert.match(full, /DISTINCT ON \(h\.contract, h\.token_id\)/)
  assert.match(full, /< \(\$2::bigint, \$3::text COLLATE "C", \$4::text COLLATE "C"\)/)
  assert.match(full, /ORDER BY d\.block DESC, d\.contract COLLATE "C" DESC, d\.token_id COLLATE "C" DESC/)
  assert.match(full, /LIMIT \$5::int/)

  assert.deepEqual(collectorHoldingsParams("0xABC", null, 5), ["0xabc", null, null, null, 5])
  assert.deepEqual(
    collectorHoldingsParams(C1, { block: 7n, contract: C2, tokenId: "3" }, 5),
    [C1, "7", C2, "3", 5],
  )
})
