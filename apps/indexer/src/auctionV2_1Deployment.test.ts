/**
 * Run with: node --experimental-strip-types --test src/auctionV2_1Deployment.test.ts
 * (from apps/indexer).
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { parseAuctionV2_1Deployment } from "./auctionV2_1Deployment.ts"

// Pure parser cases only. Ponder's build imports every file under src/
// (test files included), so nothing here asserts on the tracked record's
// current contents: that would report a failure inside a running indexer
// the day the V2.1 deploy is recorded.

const FACTORY = "0x1111111111111111111111111111111111111111"

test("empty, zero or malformed factory address is undeployed", () => {
  for (const auctionHouseV2_1Factory of [undefined, "", "0x0000000000000000000000000000000000000000", "0x1234", 42]) {
    assert.equal(
      parseAuctionV2_1Deployment({ chainId: 1, auctionHouseV2_1Factory, auctionHouseV2_1FactoryDeployBlock: 26_000_000 }),
      null,
    )
  }
})

test("an address without a positive deploy block is not subscribed (no genesis scan)", () => {
  for (const auctionHouseV2_1FactoryDeployBlock of [undefined, null, 0, -1, "26000000", 1.5]) {
    assert.equal(
      parseAuctionV2_1Deployment({ chainId: 1, auctionHouseV2_1Factory: FACTORY, auctionHouseV2_1FactoryDeployBlock }),
      null,
    )
  }
})

test("a non-mainnet record is ignored", () => {
  assert.equal(
    parseAuctionV2_1Deployment({ chainId: 11155111, auctionHouseV2_1Factory: FACTORY, auctionHouseV2_1FactoryDeployBlock: 1 }),
    null,
  )
})

test("a recorded factory and block are returned as-is", () => {
  assert.deepEqual(
    parseAuctionV2_1Deployment({ chainId: 1, auctionHouseV2_1Factory: FACTORY, auctionHouseV2_1FactoryDeployBlock: 26_000_000 }),
    { factory: FACTORY, factoryDeployBlock: 26_000_000 },
  )
})
