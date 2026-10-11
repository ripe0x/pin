/**
 * decodeMinterSaleConfig: the nine FixedPriceMinter sale getters, in
 * buildMinterContracts order, decoded into a MinterSaleConfig. Every field
 * but priceStrategy must succeed or the whole config is null (no partial
 * sale). A v2 clone reports priceStrategy as zero regardless of the read.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { decodeMinterSaleConfig, ZERO_ADDRESS, type MulticallEntry } from "./collection.ts"

const ok = <T>(result: T): MulticallEntry<T> => ({ status: "success", result })
const fail = (): MulticallEntry<never> => ({ status: "failure" })

// buildMinterContracts order: price, priceStrategy, mintStart, mintEnd,
// payoutRecipient, maxMints, allowlistRoot, walletCap, referralShareBps.
const STRATEGY = "0x1111111111111111111111111111111111111111" as const
const PAYOUT = "0x2222222222222222222222222222222222222222" as const
const ROOT = ("0x" + "ab".repeat(32)) as `0x${string}`

function fullResults(strategy: MulticallEntry<unknown>): MulticallEntry<unknown>[] {
  return [
    ok(1_000_000n), // price
    strategy, // priceStrategy
    ok(100n), // mintStart
    ok(200n), // mintEnd
    ok(PAYOUT), // payoutRecipient
    ok(50n), // maxMints
    ok(ROOT), // allowlistRoot
    ok(3n), // walletCap
    ok(500), // referralShareBps
  ]
}

test("v1: all getters succeed, priceStrategy taken from the read", () => {
  const cfg = decodeMinterSaleConfig(fullResults(ok(STRATEGY)), false)
  assert.deepEqual(cfg, {
    price: 1_000_000n,
    priceStrategy: STRATEGY,
    mintStart: 100n,
    mintEnd: 200n,
    payout: PAYOUT,
    maxMints: 50n,
    allowlistRoot: ROOT,
    walletCap: 3n,
    referralShareBps: 500,
  })
})

test("v2: priceStrategy is zeroed even when the read returns a value", () => {
  const cfg = decodeMinterSaleConfig(fullResults(ok(STRATEGY)), true)
  assert.equal(cfg?.priceStrategy, ZERO_ADDRESS)
})

test("priceStrategy read failing does not null the config (it zeroes to no-strategy)", () => {
  const cfg = decodeMinterSaleConfig(fullResults(fail()), false)
  assert.notEqual(cfg, null)
  assert.equal(cfg?.priceStrategy, ZERO_ADDRESS)
  assert.equal(cfg?.price, 1_000_000n)
})

test("a required getter failing nulls the whole config", () => {
  const results = fullResults(ok(STRATEGY))
  results[5] = fail() // maxMints
  assert.equal(decodeMinterSaleConfig(results, false), null)
})

test("too-short results (bring-your-own minter that reverts everything) is null", () => {
  assert.equal(decodeMinterSaleConfig([], false), null)
})
