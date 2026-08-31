import assert from "node:assert/strict"
import { test } from "node:test"
import { groupSecondaryFeedItems } from "./activity-secondary-grouping"
import type { EnrichedActivityEvent, EnrichedFeedItem } from "./v2-activity-types"

const T0 = 1_700_000_000

function event(
  id: string,
  kind: EnrichedActivityEvent["kind"],
  blockTime: number,
  overrides: Partial<EnrichedActivityEvent> = {},
): EnrichedActivityEvent {
  return {
    id,
    kind,
    blockTime,
    artist: "0xArtist",
    counterparty: null,
    tokenContract: "0xCollection",
    tokenId: "1",
    amountWei: null,
    reserveWei: null,
    endTime: null,
    house: null,
    collection: null,
    collectionName: null,
    txHash: null,
    quantity: null,
    auctionKey: null,
    artistDisplayName: "artist.eth",
    artistAvatarUrl: null,
    counterpartyDisplayName: null,
    counterpartyAvatarUrl: null,
    tokenTitle: "Work",
    mediaUrl: null,
    isVideo: false,
    ...overrides,
  }
}

const single = (value: EnrichedActivityEvent): EnrichedFeedItem => ({
  type: "event",
  event: value,
})

test("bids group by auction across interleaved activity", () => {
  const items = [
    single(event("b2", "auction.bid", T0 + 30, { auctionKey: "fnd:7" })),
    single(event("sale", "sale.buyNow", T0 + 20)),
    single(event("b1", "auction.firstBid", T0 + 10, { auctionKey: "fnd:7" })),
  ]
  const grouped = groupSecondaryFeedItems(items)
  assert.deepEqual(grouped.map((item) => item.type), ["bid-group", "event"])
  assert.equal(grouped[0].type === "bid-group" ? grouped[0].events.length : 0, 2)
})

test("listings group by seller and UTC day", () => {
  const items = [
    single(event("l2", "auction.opened", T0 + 30)),
    single(event("l1", "auction.opened", T0 + 10)),
    single(
      event("other", "auction.opened", T0, {
        artist: "0xOther",
        artistDisplayName: "other.eth",
      }),
    ),
  ]
  const grouped = groupSecondaryFeedItems(items)
  assert.deepEqual(grouped.map((item) => item.type), ["listing-group", "event"])
})
