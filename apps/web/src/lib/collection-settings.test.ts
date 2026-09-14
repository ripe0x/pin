/**
 * buildCollectionSettings: the studio Collection Settings /settings API
 * response shape, built from an already-read Collection (see getCollection
 * in collection-onchain.ts) plus a creator roster and the network's
 * RenderAssets address. Exercises a v1 row (v2 flags all false, as
 * decodeLocks always reports for v1) and a v2 row (every v2 flag carried
 * through), so a version regression on either side of the JSON boundary
 * shows up here without a live chain read.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildCollectionSettings, IdMode, type Collection } from "./collection.ts"

const OWNER = "0x1111111111111111111111111111111111111111" as const
const RENDERER = "0x2222222222222222222222222222222222222222" as const
const RENDER_ASSETS = "0x3333333333333333333333333333333333333333" as const

const base: Pick<
  Collection,
  | "name"
  | "owner"
  | "protocolVersion"
  | "renderer"
  | "isRendererLocked"
  | "isSupplyLocked"
  | "isMinterLocked"
  | "isRoyaltyLocked"
  | "sealed"
  | "cfg"
  | "cover"
  | "minted"
> = {
  name: "escape blue",
  owner: OWNER,
  protocolVersion: 1,
  renderer: RENDERER,
  isRendererLocked: false,
  isSupplyLocked: false,
  isMinterLocked: false,
  isRoyaltyLocked: false,
  sealed: false,
  cfg: { supplyCap: 100n, royaltyBps: 500, royaltyReceiver: OWNER, renderer: RENDERER, idMode: IdMode.Sequential },
  cover: "",
  minted: 3n,
}

test("v1 row: v2 flags are all false, bigints stringified", () => {
  const settings = buildCollectionSettings(base, [], RENDER_ASSETS)
  assert.equal(settings.protocolVersion, 1)
  assert.equal(settings.isRoyaltyLocked, false)
  assert.equal(settings.isMinterLocked, false)
  assert.equal(settings.sealed, false)
  assert.equal(settings.supplyCap, "100")
  assert.equal(settings.minted, "3")
  assert.equal(settings.royaltyBps, 500)
  assert.equal(settings.renderAssets, RENDER_ASSETS)
})

test("v2 row: every lock/seal flag carries through", () => {
  const v2: typeof base = {
    ...base,
    protocolVersion: 2,
    isRendererLocked: true,
    isSupplyLocked: true,
    isMinterLocked: true,
    isRoyaltyLocked: true,
    sealed: true,
  }
  const settings = buildCollectionSettings(v2, [{ creator: OWNER, confirmed: true }], null)
  assert.equal(settings.protocolVersion, 2)
  assert.equal(settings.isRendererLocked, true)
  assert.equal(settings.isSupplyLocked, true)
  assert.equal(settings.isMinterLocked, true)
  assert.equal(settings.isRoyaltyLocked, true)
  assert.equal(settings.sealed, true)
  // RenderAssets unconfigured on this network: the cover section's
  // deployed-guard notice keys off this being null, not "".
  assert.equal(settings.renderAssets, null)
  assert.deepEqual(settings.creators, [{ creator: OWNER, confirmed: true }])
})
