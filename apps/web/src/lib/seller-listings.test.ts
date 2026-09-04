import assert from "node:assert/strict"
import test from "node:test"
import { fetchSellerCancellableListings } from "./seller-listings.ts"

const CONTRACT = "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0"

test("seller listing client preserves partial response state and SuperRare rows", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  globalThis.fetch = async () => new Response(JSON.stringify({
    auctions: [{
      kind: "auction",
      platform: "superrareV2",
      id: `srv2:auction:${CONTRACT}:42`,
      auctionId: `${CONTRACT}:42`,
      nftContract: CONTRACT,
      tokenId: "42",
      reserveWei: "1000000000000000000",
      durationSeconds: 86400,
    }],
    buyNows: [],
  }), {
    status: 200,
    headers: { "x-seller-listings-partial": "1" },
  })

  const partial = await fetchSellerCancellableListings(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  )
  assert.equal(partial.partial, true)
  assert.equal(partial.auctions.length, 1)
  assert.equal(partial.auctions[0].platform, "superrareV2")
  assert.equal(partial.auctions[0].reserveWei, 1_000000000000000000n)
  assert.equal(partial.auctions[0].durationSeconds, 86400)

  globalThis.fetch = async () => new Response(JSON.stringify({
    auctions: [],
    buyNows: [],
  }), { status: 200 })
  const complete = await fetchSellerCancellableListings(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  )
  assert.equal(complete.partial, false)
})
