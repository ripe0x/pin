import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8")
}

test("seller-listings route forwards completeness instead of hiding partial results", async () => {
  const server = await source("./seller-listings-server.ts")
  const route = await source("../app/api/seller-listings/[address]/route.ts")

  assert.match(server, /if \(!r\.complete\) complete = false/)
  assert.match(server, /getSellerListingsResolution/)
  assert.match(server, /seller-listings:v4:/)
  assert.match(server, /PartialSellerListingsError/)
  assert.doesNotMatch(server, /return buildPayload\(seller\)/)
  assert.match(route, /result\.complete \? undefined/)
  assert.match(route, /"x-seller-listings-partial": "1"/)
})

test("SuperRare delist discovery is indexed, bid-free, fresh, and cost bounded", async () => {
  const adapter = await source("./platforms/superrareV2.ts")
  const start = adapter.indexOf("async getCancellableListingsForSeller")
  assert.notEqual(start, -1)
  const method = adapter.slice(start)

  assert.match(method, /FROM srv2_active_auctions/)
  assert.match(method, /current_bidder IS NULL/)
  assert.match(method, /current_bid_wei::numeric = 0/)
  assert.match(method, /FROM srv2_listing_coverage/)
  assert.match(method, /SELECT 1 FROM known_artists/)
  assert.match(method, /coverage\.eligible === true/)
  assert.doesNotMatch(method, /getLogs|readContract|multicall/)
})

test("SuperRare worker persists duration and an atomic coverage watermark", async () => {
  const worker = await source("../../../worker/src/tasks/scan-srv2-active-auctions.ts")
  const transaction = worker.slice(worker.indexOf("await sql.begin"))

  assert.match(worker, /duration_seconds/)
  assert.match(transaction, /INSERT INTO srv2_listing_coverage/)
  assert.match(transaction, /indexed_through_block/)
  assert.match(transaction, /finalized_target_block/)
  assert.ok(
    transaction.indexOf("INSERT INTO srv2_active_auctions") <
      transaction.indexOf("INSERT INTO srv2_listing_coverage"),
  )
})
