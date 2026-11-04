/** /collections browse index paging (issue #262). */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  COLLECTIONS_PAGE_SIZE,
  collectionsPageHref,
  pageNav,
  pageOffset,
  parsePageParam,
  totalPages,
} from "./collections-pagination.ts"

test("parsePageParam: positive integers only, everything else is page 1", () => {
  assert.equal(parsePageParam(undefined), 1)
  assert.equal(parsePageParam(""), 1)
  assert.equal(parsePageParam("1"), 1)
  assert.equal(parsePageParam("3"), 3)
  assert.equal(parsePageParam("0"), 1)
  assert.equal(parsePageParam("-2"), 1)
  assert.equal(parsePageParam("2.5"), 1)
  assert.equal(parsePageParam("abc"), 1)
  assert.equal(parsePageParam("4abc"), 1)
  assert.equal(parsePageParam("99999999999999999999"), 1)
  assert.equal(parsePageParam(["2", "5"]), 2)
})

test("pageOffset: 24 per page, page 1 starts at 0", () => {
  assert.equal(COLLECTIONS_PAGE_SIZE, 24)
  assert.equal(pageOffset(1), 0)
  assert.equal(pageOffset(2), 24)
  assert.equal(pageOffset(5, 10), 40)
  assert.equal(pageOffset(0), 0)
})

test("totalPages: at least 1, rounds up", () => {
  assert.equal(totalPages(0), 1)
  assert.equal(totalPages(1), 1)
  assert.equal(totalPages(24), 1)
  assert.equal(totalPages(25), 2)
  assert.equal(totalPages(48), 2)
  assert.equal(totalPages(49), 3)
})

test("collectionsPageHref: page 1 is the bare path", () => {
  assert.equal(collectionsPageHref(1), "/collections")
  assert.equal(collectionsPageHref(0), "/collections")
  assert.equal(collectionsPageHref(2), "/collections?page=2")
})

test("pageNav: newer/older links at the edges and in the middle", () => {
  assert.deepEqual(pageNav(1, 10), { page: 1, totalPages: 1, newerHref: null, olderHref: null })
  assert.deepEqual(pageNav(1, 50), { page: 1, totalPages: 3, newerHref: null, olderHref: "/collections?page=2" })
  assert.deepEqual(pageNav(2, 50), {
    page: 2,
    totalPages: 3,
    newerHref: "/collections",
    olderHref: "/collections?page=3",
  })
  assert.deepEqual(pageNav(3, 50), { page: 3, totalPages: 3, newerHref: "/collections?page=2", olderHref: null })
})

test("pageNav: a page past the end links back to the last real page", () => {
  const nav = pageNav(9, 50)
  assert.equal(nav.totalPages, 3)
  assert.equal(nav.newerHref, "/collections?page=3")
  assert.equal(nav.olderHref, null)
})
