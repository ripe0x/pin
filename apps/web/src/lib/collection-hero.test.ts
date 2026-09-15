import { test } from "node:test"
import assert from "node:assert/strict"
import { selectPreMintHero } from "./collection-hero.ts"

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
