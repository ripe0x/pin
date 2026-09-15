import { test } from "node:test"
import assert from "node:assert/strict"
import { selectCollectionHeroMode, selectPreMintHero } from "./collection-hero.ts"

test("selectPreMintHero: cover wins whenever present", () => {
  assert.equal(selectPreMintHero(true, true), "cover")
  assert.equal(selectPreMintHero(true, false), "cover")
})

test("selectPreMintHero: sample when there is no cover but a sample renders", () => {
  assert.equal(selectPreMintHero(false, true), "sample")
})

test("selectPreMintHero: fallback when neither a cover nor a sample is available", () => {
  assert.equal(selectPreMintHero(false, false), "fallback")
})

test("selectCollectionHeroMode: pre-mint is always single", () => {
  assert.equal(selectCollectionHeroMode(true, 0), "single")
  assert.equal(selectCollectionHeroMode(true, 12), "single")
})

test("selectCollectionHeroMode: minted with grid tokens is grid", () => {
  assert.equal(selectCollectionHeroMode(false, 1), "grid")
  assert.equal(selectCollectionHeroMode(false, 12), "grid")
})

test("selectCollectionHeroMode: minted with no grid tokens falls back to single", () => {
  assert.equal(selectCollectionHeroMode(false, 0), "single")
})
