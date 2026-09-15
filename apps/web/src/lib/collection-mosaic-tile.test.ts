import { test } from "node:test"
import assert from "node:assert/strict"
import { selectMosaicTileVisual } from "./collection-mosaic-tile.ts"

function select(overrides: Partial<Parameters<typeof selectMosaicTileVisual>[0]> = {}) {
  return selectMosaicTileVisual({
    image: null,
    animationUrl: null,
    cover: null,
    number: 3,
    position: 0,
    ...overrides,
  })
}

test("selectMosaicTileVisual: the tile's own image wins over everything else", () => {
  assert.deepEqual(
    select({ image: "ipfs://img", animationUrl: "ipfs://anim", cover: "ipfs://cover", position: 9 }),
    { kind: "image", src: "ipfs://img" },
  )
})

test("selectMosaicTileVisual: the collection cover wins over an animation when there is no image", () => {
  assert.deepEqual(
    select({ animationUrl: "ipfs://anim", cover: "ipfs://cover", number: 5 }),
    { kind: "cover", src: "ipfs://cover", number: 5 },
  )
})

test("selectMosaicTileVisual: a live iframe when there is no image or cover and the position is under the limit", () => {
  assert.deepEqual(
    select({ animationUrl: "ipfs://anim", position: 3 }),
    { kind: "iframe", src: "ipfs://anim" },
  )
})

test("selectMosaicTileVisual: a numbered placeholder once the position reaches the iframe limit", () => {
  assert.deepEqual(select({ animationUrl: "ipfs://anim", position: 4, number: 5 }), { kind: "number", number: 5 })
})

test("selectMosaicTileVisual: a custom iframeLimit is honored", () => {
  assert.deepEqual(
    select({ animationUrl: "ipfs://anim", position: 1, iframeLimit: 1 }),
    { kind: "number", number: 3 },
  )
  assert.deepEqual(
    select({ animationUrl: "ipfs://anim", position: 0, iframeLimit: 1 }),
    { kind: "iframe", src: "ipfs://anim" },
  )
})

test("selectMosaicTileVisual: a numbered placeholder when nothing at all is available", () => {
  assert.deepEqual(select({ number: 7 }), { kind: "number", number: 7 })
})
