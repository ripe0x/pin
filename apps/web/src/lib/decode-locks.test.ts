/**
 * decodeLocks: the lock/seal facts getCollection() assembles from one
 * multicall. A v2 row with a successful permanence() call takes every flag
 * from that tuple; a v1 row (or a v2 row whose permanence() call itself
 * failed, e.g. an older v2 implementation) falls back to the individual
 * isRendererLocked/isSupplyLocked reads with isRoyaltyLocked/sealed false,
 * without throwing.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { decodeLocks, type MulticallEntry, type PermanenceTuple } from "./collection.ts"

const individual = { isRendererLocked: false, isSupplyLocked: true }

test("v2 row with a permanence tuple maps all five flags", () => {
  const permanence: MulticallEntry<PermanenceTuple> = {
    status: "success",
    result: [true, true, true, true, true, 2n], // renderer, supply, minter, royalty, sealed, version
  }
  const locks = decodeLocks(2, individual, permanence)
  assert.deepEqual(locks, {
    isRendererLocked: true,
    isSupplyLocked: true,
    isRoyaltyLocked: true,
    sealed: true,
  })
})

test("v1 row (permanence call fails) maps sealed=false and isRoyaltyLocked=false, falls back to the individual reads", () => {
  const permanence: MulticallEntry<PermanenceTuple> = { status: "failure" }
  const locks = decodeLocks(1, individual, permanence)
  assert.deepEqual(locks, {
    isRendererLocked: individual.isRendererLocked,
    isSupplyLocked: individual.isSupplyLocked,
    isRoyaltyLocked: false,
    sealed: false,
  })
})

test("v2 row whose permanence() call itself failed also falls back cleanly, no throw", () => {
  const permanence: MulticallEntry<PermanenceTuple> = { status: "failure" }
  assert.doesNotThrow(() => decodeLocks(2, individual, permanence))
  const locks = decodeLocks(2, individual, permanence)
  assert.deepEqual(locks, {
    isRendererLocked: individual.isRendererLocked,
    isSupplyLocked: individual.isSupplyLocked,
    isRoyaltyLocked: false,
    sealed: false,
  })
})

test("missing permanence entry (undefined) is treated the same as a failure", () => {
  assert.doesNotThrow(() => decodeLocks(1, individual, undefined))
  const locks = decodeLocks(1, individual, undefined)
  assert.equal(locks.sealed, false)
  assert.equal(locks.isRoyaltyLocked, false)
})
