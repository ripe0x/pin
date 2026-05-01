/**
 * Run with:
 *   node --experimental-strip-types --test \
 *     apps/web/src/lib/platforms/cancel-calls.test.ts
 *
 * Unit-tests the platform-dispatch logic in `cancel-calls.ts`. Each
 * platform produces a wagmi-shaped contract call and an EIP-5792
 * encoded `(to, data, value)` tuple; we assert the address, function
 * selector (4-byte hash), and arg shape per platform.
 *
 * The function selectors are stable on-chain identifiers — if a refactor
 * accidentally swaps `cancelReserveAuction` for `cancelBuyPrice` (or
 * routes SR cancels to FND's market) the selector mismatch fails the
 * test before a user wallet ever sees the wrong tx.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { keccak256, toHex, type Address } from "viem"
import {
  buildCancelCall,
  encodeCancelCallToData,
} from "./cancel-calls.ts"
import type {
  AuctionListing,
  BuyNowListing,
  SellerListing,
} from "../seller-listings.ts"

// Mainnet addresses replicated here (rather than imported from
// `@pin/addresses`) so the test runs under Node's bare TS-strip loader,
// which doesn't resolve workspace package aliases. If the production
// addresses ever change, the assertions below fail loudly and the test
// is the canonical place to update.
const NFT_MARKET_MAINNET: Address =
  "0xcDA72070E455bb31C7690a170224Ce43623d0B6f"
const SUPERRARE_BAZAAR_MAINNET: Address =
  "0x6d7c44773c52d396f43c2d511b81aa168e9a7a42"

// 4-byte function selectors derived from canonical signatures. We compute
// them at test time so the test doesn't drift from on-chain reality if
// someone accidentally renames a function in the local ABI file.
function selector(signature: string): `0x${string}` {
  return keccak256(toHex(signature)).slice(0, 10) as `0x${string}`
}

const SEL_CANCEL_RESERVE_AUCTION = selector("cancelReserveAuction(uint256)")
const SEL_CANCEL_BUY_PRICE = selector("cancelBuyPrice(address,uint256)")
const SEL_SR_CANCEL_AUCTION = selector("cancelAuction(address,uint256)")

const NFT_CONTRACT: Address = "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0"
const TOKEN_ID = "42"

function fndAuction(): AuctionListing {
  return {
    kind: "auction",
    platform: "foundation",
    id: "fnd:auction:123",
    auctionId: "123",
    nftContract: NFT_CONTRACT,
    tokenId: TOKEN_ID,
    reserveWei: 1_000000000000000000n,
    durationSeconds: 86_400,
  }
}

function fndBuyNow(): BuyNowListing {
  return {
    kind: "buyNow",
    platform: "foundation",
    id: "fnd:buyNow:0xabc:42",
    nftContract: NFT_CONTRACT,
    tokenId: TOKEN_ID,
    priceWei: 2_000000000000000000n,
  }
}

function srV2Auction(): AuctionListing {
  return {
    kind: "auction",
    platform: "superrareV2",
    id: `srv2:auction:${NFT_CONTRACT}:${TOKEN_ID}`,
    auctionId: `${NFT_CONTRACT}:${TOKEN_ID}`,
    nftContract: NFT_CONTRACT,
    tokenId: TOKEN_ID,
    reserveWei: 500_000000000000000n,
    durationSeconds: 24 * 60 * 60,
  }
}

test("buildCancelCall: foundation auction → cancelReserveAuction(auctionId)", () => {
  const call = buildCancelCall(fndAuction())
  assert.equal(
    call.address.toLowerCase(),
    NFT_MARKET_MAINNET.toLowerCase(),
  )
  assert.equal(call.functionName, "cancelReserveAuction")
  assert.deepEqual(call.args, [123n])
  assert.equal(call.value, undefined)

  const encoded = encodeCancelCallToData(fndAuction())
  assert.equal(encoded.to.toLowerCase(), call.address.toLowerCase())
  assert.equal(encoded.data.slice(0, 10), SEL_CANCEL_RESERVE_AUCTION)
})

test("buildCancelCall: foundation buy-now → cancelBuyPrice(contract, tokenId)", () => {
  const call = buildCancelCall(fndBuyNow())
  assert.equal(
    call.address.toLowerCase(),
    NFT_MARKET_MAINNET.toLowerCase(),
  )
  assert.equal(call.functionName, "cancelBuyPrice")
  assert.deepEqual(call.args, [NFT_CONTRACT, BigInt(TOKEN_ID)])

  const encoded = encodeCancelCallToData(fndBuyNow())
  assert.equal(encoded.data.slice(0, 10), SEL_CANCEL_BUY_PRICE)
})

test("buildCancelCall: SR V2 auction → Bazaar.cancelAuction(contract, tokenId)", () => {
  const call = buildCancelCall(srV2Auction())
  // Critical: routes to Bazaar, NOT to Foundation's NFTMarket.
  assert.equal(
    call.address.toLowerCase(),
    SUPERRARE_BAZAAR_MAINNET.toLowerCase(),
  )
  assert.notEqual(
    call.address.toLowerCase(),
    NFT_MARKET_MAINNET.toLowerCase(),
  )
  assert.equal(call.functionName, "cancelAuction")
  assert.deepEqual(call.args, [NFT_CONTRACT, BigInt(TOKEN_ID)])

  const encoded = encodeCancelCallToData(srV2Auction())
  assert.equal(encoded.to.toLowerCase(), call.address.toLowerCase())
  assert.equal(encoded.data.slice(0, 10), SEL_SR_CANCEL_AUCTION)
})

test("buildCancelCall: sovereign listing throws (destination, not source)", () => {
  // Sovereign auctions are the migrate destination; they should never
  // appear in the cancellable-listings stream. Defensive throw.
  const sovereign = {
    ...srV2Auction(),
    platform: "sovereign" as const,
  } satisfies SellerListing
  assert.throws(() => buildCancelCall(sovereign), /sovereign/)
})

test("buildCancelCall: manifold listing throws (no marketplace)", () => {
  const manifold = {
    ...srV2Auction(),
    platform: "manifold" as const,
  } satisfies SellerListing
  assert.throws(() => buildCancelCall(manifold), /manifold/)
})

test("encodeCancelCallToData: same selector for SR and FND-buy-now produces different data", () => {
  // SR V2's cancelAuction(address,uint256) and FND's cancelBuyPrice(address,uint256)
  // share an arg shape but live on different contracts with different
  // selectors. The encoded calldata must NOT collide.
  const sr = encodeCancelCallToData(srV2Auction())
  const fnd = encodeCancelCallToData(fndBuyNow())
  assert.notEqual(sr.to.toLowerCase(), fnd.to.toLowerCase())
  assert.notEqual(sr.data.slice(0, 10), fnd.data.slice(0, 10))
})
