import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  catalogEntryCount,
  defaultProfileTab,
  formatTabCount,
  parseProfileTab,
  profileTabHref,
  selectProfileTabs,
  type ProfileTabCounts,
} from "./profile-tabs.ts"

const A = "0x1111111111111111111111111111111111111111"
const counts = (c: Partial<ProfileTabCounts>): ProfileTabCounts => ({
  available: 0, created: 0, collected: 0, catalog: 0, ...c,
})

test("?tab= parses known tabs only", () => {
  assert.equal(parseProfileTab("collected"), "collected")
  assert.equal(parseProfileTab(" Catalog "), "catalog")
  assert.equal(parseProfileTab(["available", "created"]), "available")
  assert.equal(parseProfileTab("curation"), null)
  assert.equal(parseProfileTab(""), null)
  assert.equal(parseProfileTab(undefined), null)
  assert.equal(parseProfileTab(null), null)
  assert.equal(parseProfileTab([]), null)
})

test("default: Created for artists, Collected for collector-only addresses", () => {
  assert.equal(defaultProfileTab(counts({ created: 3, collected: 40 })), "created")
  assert.equal(defaultProfileTab(counts({ collected: 2 })), "collected")
  assert.equal(defaultProfileTab(counts({ catalog: 1 })), "catalog")
  // Available is prominent but never the landing tab while anything else exists.
  assert.equal(defaultProfileTab(counts({ available: 2, collected: 1 })), "collected")
  assert.equal(defaultProfileTab(counts({ available: 2 })), "available")
  // Nothing anywhere keeps the gallery's "No works found" copy.
  assert.equal(defaultProfileTab(counts({})), "created")
})

test("a failed count never moves an artist off Created, and never becomes the default otherwise", () => {
  assert.equal(defaultProfileTab(counts({ created: null, collected: 5 })), "created")
  assert.equal(defaultProfileTab(counts({ collected: null, catalog: 1 })), "catalog")
  assert.equal(defaultProfileTab(counts({ collected: null })), "created")
})

test("tabs with no content are hidden; unknown counts and the active tab stay listed", () => {
  const dual = selectProfileTabs(null, counts({ created: 12, collected: 4 }))
  assert.deepEqual(dual, { active: "created", tabs: ["created", "collected"], defaultTab: "created" })

  const collector = selectProfileTabs(null, counts({ collected: 4 }))
  assert.deepEqual(collector.tabs, ["collected"])
  assert.equal(collector.active, "collected")

  const all = selectProfileTabs(null, counts({ available: 1, created: 1, collected: 1, catalog: 1 }))
  assert.deepEqual(all.tabs, ["available", "created", "collected", "catalog"])

  const coldDb = selectProfileTabs(null, counts({ created: 3, collected: null }))
  assert.deepEqual(coldDb.tabs, ["created", "collected"])
})

test("an explicit ?tab= is honoured even when empty, so shared links don't switch views", () => {
  const sel = selectProfileTabs("collected", counts({ created: 5 }))
  assert.equal(sel.active, "collected")
  assert.deepEqual(sel.tabs, ["created", "collected"])
  assert.equal(sel.defaultTab, "created")
})

test("the default tab links to the bare path; others carry ?tab=", () => {
  assert.equal(profileTabHref(A, "created", "created"), `/artist/${A}`)
  assert.equal(profileTabHref(A, "collected", "created"), `/artist/${A}?tab=collected`)
  assert.equal(profileTabHref(A, "collected", "collected"), `/artist/${A}`)
  assert.equal(profileTabHref(A, "created", "collected"), `/artist/${A}?tab=created`)
})

test("catalog entries and tab badges", () => {
  assert.equal(catalogEntryCount({ contracts: [1, 2], tokens: [1], tokenRanges: [] }), 3)
  assert.equal(formatTabCount(null), "—")
  assert.equal(formatTabCount(0), "0")
  assert.equal(formatTabCount(999), "999")
  assert.equal(formatTabCount(1000), "1k")
  assert.equal(formatTabCount(1250), "1.2k")
  assert.equal(formatTabCount(12_345), "12k")
})
