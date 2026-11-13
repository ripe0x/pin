/**
 * Run with: node --experimental-strip-types --test src/sovereignV2Status.test.ts
 * (from apps/indexer). Node 22's native TypeScript support handles this file
 * directly, no ponder:registry/ponder:schema imports here, so it needs no
 * live indexer environment, unlike SovereignV2.ts itself.
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  HELD_FOR_WINNER,
  HOUSE_VERSION,
  resolveAuctionEndedStatus,
  resolveLotHeldForWinnerStatus,
  resolveLotUnwoundStatus,
} from "./sovereignV2Status.ts"

test("LotUnwound on a still-deferred row resolves to unwound (return-to-seller succeeded)", () => {
  assert.equal(resolveLotUnwoundStatus("deferred"), "unwound")
})

test("LotUnwound keeps unwound_return_pending when LotReturnDeferred already set it in the same tx", () => {
  assert.equal(resolveLotUnwoundStatus("unwound_return_pending"), "unwound_return_pending")
})

test("LotUnwound is idempotent on an already-unwound row", () => {
  assert.equal(resolveLotUnwoundStatus("unwound"), "unwound")
})

test("an unrelated status still resolves to unwound (defensive default)", () => {
  assert.equal(resolveLotUnwoundStatus("active"), "unwound")
})

// ── V2.1: LotHeldForWinner ───────────────────────────────────────────────
// On chain (contracts/src/SovereignAuctionHouseV2_1.sol):
//   endAuction, delivered            -> AuctionEnded
//   endAuction, held for winner      -> AuctionEnded, LotHeldForWinner
//   endAuction, lot not transferable -> DeliveryDeferred
//   unwindStuckLot on a deferred lot -> AuctionEnded + LotClaimed (retry
//                                       delivered), AuctionEnded +
//                                       LotHeldForWinner (now transferable),
//                                       or LotUnwound (+ LotReturnDeferred)
//   claimLot on a held lot           -> LotClaimed only
//   claimLot on a deferred lot       -> AuctionEnded, LotClaimed

/** Replays one event sequence through the pure transitions, mirroring SovereignV2.ts. */
function replay(events: string[], start = "active"): string {
  let status = start
  let claimed = false
  for (const e of events) {
    if (e === "AuctionEnded") status = resolveAuctionEndedStatus(status)
    else if (e === "LotHeldForWinner") status = resolveLotHeldForWinnerStatus(claimed)
    else if (e === "LotClaimed") {
      status = "settled"
      claimed = true
    } else if (e === "DeliveryDeferred") status = "deferred"
    else if (e === "LotReturnDeferred") status = "unwound_return_pending"
    else if (e === "LotUnwound") status = resolveLotUnwoundStatus(status)
    else if (e === "LotReturned") status = "unwound"
    else throw new Error(`unknown event ${e}`)
  }
  return status
}

test("V2.1 house version is 21: distinct from V1 and V2, and V2-compatible by version >= 2", () => {
  assert.equal(HOUSE_VERSION.V1, 1)
  assert.equal(HOUSE_VERSION.V2, 2)
  assert.equal(HOUSE_VERSION.V2_1, 21)
  assert.ok(HOUSE_VERSION.V2_1 >= HOUSE_VERSION.V2)
})

test("AuctionEnded settles an active or deferred row", () => {
  assert.equal(resolveAuctionEndedStatus("active"), "settled")
  assert.equal(resolveAuctionEndedStatus("deferred"), "settled")
})

test("AuctionEnded never clobbers held_for_winner (order-independent within the endAuction tx)", () => {
  assert.equal(resolveAuctionEndedStatus(HELD_FOR_WINNER), "held_for_winner")
})

test("LotHeldForWinner holds the lot unless the claim was already recorded", () => {
  assert.equal(resolveLotHeldForWinnerStatus(false), "held_for_winner")
  assert.equal(resolveLotHeldForWinnerStatus(true), "settled")
})

test("endAuction held path: AuctionEnded then LotHeldForWinner -> held_for_winner", () => {
  assert.equal(replay(["AuctionEnded", "LotHeldForWinner"]), "held_for_winner")
})

test("endAuction held path processed out of order still ends held_for_winner", () => {
  assert.equal(replay(["LotHeldForWinner", "AuctionEnded"]), "held_for_winner")
})

test("claimLot on a held lot (LotClaimed only) -> settled", () => {
  assert.equal(replay(["AuctionEnded", "LotHeldForWinner", "LotClaimed"]), "settled")
})

test("endAuction then claimLot batched in one tx, processed out of order, stays settled", () => {
  assert.equal(replay(["AuctionEnded", "LotClaimed", "LotHeldForWinner"]), "settled")
})

test("unwindStuckLot on a deferred lot that became transferable -> held_for_winner, then claim -> settled", () => {
  assert.equal(replay(["DeliveryDeferred", "AuctionEnded", "LotHeldForWinner"]), "held_for_winner")
  assert.equal(
    replay(["DeliveryDeferred", "AuctionEnded", "LotHeldForWinner", "LotClaimed"]),
    "settled",
  )
})

test("V2 paths are unchanged under the shared handlers", () => {
  assert.equal(replay(["AuctionEnded"]), "settled")
  assert.equal(replay(["DeliveryDeferred"]), "deferred")
  assert.equal(replay(["DeliveryDeferred", "AuctionEnded", "LotClaimed"]), "settled")
  assert.equal(replay(["DeliveryDeferred", "LotUnwound"]), "unwound")
  assert.equal(replay(["DeliveryDeferred", "LotReturnDeferred", "LotUnwound"]), "unwound_return_pending")
  assert.equal(
    replay(["DeliveryDeferred", "LotReturnDeferred", "LotUnwound", "LotReturned"]),
    "unwound",
  )
})
