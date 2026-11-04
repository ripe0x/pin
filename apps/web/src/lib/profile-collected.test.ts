import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  balanceLabel,
  collectedPageUrl,
  collectedProgress,
  initialCollectedState,
  mergeCollectedPage,
  parseCollectedPage,
  type CollectedCard,
  type CollectedPage,
} from "./profile-collected.ts"

const C = "0x1111111111111111111111111111111111111111"
const W = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"

const card = (tokenId: string, extra: Partial<CollectedCard> = {}): CollectedCard => ({
  contract: C, tokenId, standard: "erc721", balance: "1", acquiredBlock: "100",
  source: "token_owners", title: null, artwork: { kind: "none" }, artist: null, artistLabel: null,
  ...extra,
})
const page = (ids: string[], total: number, nextCursor: string | null): CollectedPage => ({
  items: ids.map((id) => card(id)), total, nextCursor, coverage: "pnd-indexed-works",
})

test("initial state takes the SSR page as is", () => {
  const s = initialCollectedState(page(["3", "2"], 5, "c1"))
  assert.deepEqual(s.items.map((i) => i.tokenId), ["3", "2"])
  assert.equal(s.total, 5)
  assert.equal(s.nextCursor, "c1")
})

test("Load more appends, follows the cursor, and stops on the last page", () => {
  let s = initialCollectedState(page(["5", "4"], 5, "c1"))
  s = mergeCollectedPage(s, page(["3", "2"], 5, "c2"), "c1")
  assert.deepEqual(s.items.map((i) => i.tokenId), ["5", "4", "3", "2"])
  assert.equal(s.nextCursor, "c2")
  s = mergeCollectedPage(s, page(["1"], 5, null), "c2")
  assert.equal(s.items.length, 5)
  assert.equal(s.nextCursor, null)
})

test("a holding already on screen is not shown twice", () => {
  let s = initialCollectedState(page(["5", "4"], 5, "c1"))
  s = mergeCollectedPage(s, page(["4", "3"], 5, "c2"), "c1")
  assert.deepEqual(s.items.map((i) => i.tokenId), ["5", "4", "3"])
  assert.equal(s.nextCursor, "c2")
})

test("a stalled cursor ends paging instead of looping", () => {
  const start = initialCollectedState(page(["5", "4"], 9, "c1"))
  const same = mergeCollectedPage(start, page(["3"], 9, "c1"), "c1")
  assert.equal(same.nextCursor, null)
  const nothingNew = mergeCollectedPage(start, page(["5", "4"], 9, "c2"), "c1")
  assert.equal(nothingNew.nextCursor, null)
})

test("total follows the latest page but never drops below what is shown", () => {
  let s = initialCollectedState(page(["5", "4"], 5, "c1"))
  s = mergeCollectedPage(s, page(["3"], 1, null), "c1")
  assert.equal(s.total, 3)
})

test("holdings URL: lowercased address, limit, optional cursor", () => {
  assert.equal(collectedPageUrl(W, null), `/api/collector/${W.toLowerCase()}/holdings?limit=24&exclude=own`)
  assert.equal(
    collectedPageUrl(W, "abc_-1", 10),
    `/api/collector/${W.toLowerCase()}/holdings?limit=10&exclude=own&cursor=abc_-1`,
  )
})

test("progress and balance labels", () => {
  assert.equal(collectedProgress(24, 130), "Showing 24 of 130")
  assert.equal(collectedProgress(7, 7), "Showing all 7")
  assert.equal(balanceLabel(card("1")), null)
  assert.equal(balanceLabel(card("1", { standard: "erc1155", balance: "1" })), null)
  assert.equal(balanceLabel(card("1", { standard: "erc1155", balance: "3" })), "×3")
  assert.equal(balanceLabel(card("1", { standard: "erc1155", balance: "x" })), null)
})

test("API bodies are validated before they reach state", () => {
  assert.throws(() => parseCollectedPage(null))
  assert.throws(() => parseCollectedPage({ error: "Failed to read holdings" }))
  const p = parseCollectedPage({ items: [card("1")], total: 1, nextCursor: "" })
  assert.equal(p.nextCursor, null)
  assert.equal(p.items.length, 1)
})
