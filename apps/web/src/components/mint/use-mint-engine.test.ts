import { strict as assert } from "node:assert"
import { test } from "node:test"
import type { MintSnapshot } from "../../lib/mint-onchain.ts"
import { canMintSnapshot, deriveMintPricing } from "./use-mint-engine.ts"

function snapshot(readStatus: MintSnapshot["readStatus"], priceWei = "0"): MintSnapshot {
  return {
    readStatus,
    priceWei,
    minted: "0",
    cap: "0",
    mintStart: "0",
    mintEnd: "0",
  }
}

test("an unavailable live snapshot is neither gas-only nor mintable", () => {
  const pricing = deriveMintPricing(snapshot("unavailable"), false, null)

  assert.equal(pricing.snapshotAvailable, false)
  assert.equal(pricing.gasOnly, false)
  assert.equal(
    canMintSnapshot({
      snapshotAvailable: pricing.snapshotAvailable,
      ready: true,
      notStarted: false,
      windowClosed: false,
      soldOut: false,
      alreadyMinted: false,
      phaseResolved: true,
    }),
    false,
  )
})

test("a legacy cached snapshot without integrity status fails closed", () => {
  const legacy = {
    priceWei: "0",
    minted: "0",
    cap: "0",
    mintStart: "0",
    mintEnd: "0",
  } as MintSnapshot

  const pricing = deriveMintPricing(legacy, false, null)
  assert.equal(pricing.snapshotAvailable, false)
  assert.equal(pricing.gasOnly, false)
})

test("a verified zero fixed price remains a legitimate gas-only mint", () => {
  const pricing = deriveMintPricing(snapshot("available"), false, null)

  assert.equal(pricing.snapshotAvailable, true)
  assert.equal(pricing.price, 0n)
  assert.equal(pricing.gasOnly, true)
})

test("an available nonzero price remains payable", () => {
  const pricing = deriveMintPricing(snapshot("available", "10000000000000000"), false, null)

  assert.equal(pricing.price, 10_000_000_000_000_000n)
  assert.equal(pricing.gasOnly, false)
})
