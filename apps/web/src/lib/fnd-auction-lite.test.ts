// Run: node --test --experimental-strip-types --no-warnings src/lib/fnd-auction-lite.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { toFndAuctionLite } from "./fnd-auction-lite.ts"

const NOW = 1_000_000

test("no bid → listed, amount is the reserve", () => {
  const a = toFndAuctionLite({
    auctionId: "1", reserveWei: "50", highestBidWei: "0",
    hasBidder: false, endTime: 0, nowSec: NOW,
  })
  assert.equal(a.bucket, "listed")
  assert.equal(a.amount, "50")
  assert.equal(a.reservePrice, "50")
  assert.equal(a.firstBidTime, "0")
})

test("bid, ending in future → active, amount is the bid", () => {
  const a = toFndAuctionLite({
    auctionId: "2", reserveWei: "50", highestBidWei: "80",
    hasBidder: true, endTime: NOW + 500, nowSec: NOW,
  })
  assert.equal(a.bucket, "active")
  assert.equal(a.amount, "80")
  assert.equal(a.reservePrice, "50")
  assert.notEqual(a.firstBidTime, "0")
})

test("bid, end time passed → ending", () => {
  const a = toFndAuctionLite({
    auctionId: "3", reserveWei: "50", highestBidWei: "80",
    hasBidder: true, endTime: NOW - 10, nowSec: NOW,
  })
  assert.equal(a.bucket, "ending")
  assert.equal(a.amount, "80")
})

test("hasBidder but endTime 0 is treated as awaiting first bid (listed)", () => {
  const a = toFndAuctionLite({
    auctionId: "4", reserveWei: "50", highestBidWei: "0",
    hasBidder: true, endTime: 0, nowSec: NOW,
  })
  assert.equal(a.bucket, "listed")
  assert.equal(a.amount, "50")
})
