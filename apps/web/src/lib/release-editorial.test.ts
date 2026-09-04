import assert from "node:assert/strict"
import test from "node:test"
import {
  featuredReleaseEditorial,
  getReleaseEditorial,
  releaseEditorial,
} from "./release-editorial"

test("editorial releases are unique lowercase collection records", () => {
  const collections = releaseEditorial.map((entry) => entry.collection)
  assert.ok(releaseEditorial.length <= 12)
  assert.equal(new Set(collections).size, collections.length)
  assert.ok(collections.every((collection) => /^0x[a-f0-9]{40}$/.test(collection)))
  assert.ok(
    releaseEditorial.every(
      (entry) => entry.slug === null || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug),
    ),
  )
  assert.ok(
    releaseEditorial.every(
      (entry) => entry.editorialSummary === null || entry.editorialSummary.length <= 500,
    ),
  )
})

test("featured releases have a deterministic order", () => {
  const featured = featuredReleaseEditorial()
  assert.ok(featured.length > 0)
  assert.deepEqual(
    featured.map((entry) => entry.featureOrder),
    [...featured].sort((a, b) => (a.featureOrder ?? 0) - (b.featureOrder ?? 0))
      .map((entry) => entry.featureOrder),
  )
})

test("lookups are case-insensitive and preserve editorial truth", () => {
  const featured = featuredReleaseEditorial()[0]
  assert.equal(getReleaseEditorial(featured.collection.toUpperCase())?.featured, true)
  assert.ok(featured.editorialSummary)
})
