import assert from "node:assert/strict"
import { test } from "node:test"
import {
  appendFeedPage,
  buildEnrichedGroup,
  groupFeedEvents,
  MINT_GROUP_MAX_GAP_SECONDS,
} from "./activity-grouping"
import type {
  EnrichedActivityEvent,
  EnrichedFeedItem,
  EnrichedMintGroup,
} from "./v2-activity-types"

// ── fixtures ─────────────────────────────────────────────────────────────

type Rawish = {
  id: string
  kind: string
  blockTime: number
  artist: string
  tokenContract: string | null
  quantity: number | null
}

const T0 = 1_700_000_000

function mint(
  id: string,
  blockTime: number,
  opts: Partial<Rawish> = {},
): Rawish {
  return {
    id,
    kind: "mint",
    blockTime,
    artist: "0xArtist",
    tokenContract: "0xCoLLection",
    quantity: null,
    ...opts,
  }
}

function bid(id: string, blockTime: number): Rawish {
  return {
    id,
    kind: "auction.bid",
    blockTime,
    artist: "0xSeller",
    tokenContract: "0xNft",
    quantity: null,
  }
}

function enriched(
  id: string,
  blockTime: number,
  opts: Partial<EnrichedActivityEvent> = {},
): EnrichedActivityEvent {
  return {
    id,
    kind: "mint",
    blockTime,
    artist: "0xArtist",
    counterparty: `0xMinter${id}`,
    tokenContract: "0xCollection",
    tokenId: "1",
    amountWei: 10n,
    reserveWei: null,
    endTime: null,
    house: null,
    collection: "0xCollection",
    collectionName: "Drop",
    txHash: null,
    quantity: null,
    artistDisplayName: "artist.eth",
    artistAvatarUrl: null,
    counterpartyDisplayName: null,
    counterpartyAvatarUrl: null,
    tokenTitle: "Drop #1",
    mediaUrl: null,
    isVideo: false,
    ...opts,
  } as EnrichedActivityEvent
}

const single = (e: EnrichedActivityEvent): EnrichedFeedItem => ({
  type: "event",
  event: e,
})

// ── groupFeedEvents ──────────────────────────────────────────────────────

test("runs of 3+ same-key mints collapse; below threshold stays singles", () => {
  const events = [mint("a", T0 + 20), mint("b", T0 + 10), mint("c", T0)]
  const items = groupFeedEvents(events)
  assert.equal(items.length, 1)
  assert.equal(items[0].type, "run")

  const two = groupFeedEvents([mint("a", T0 + 10), mint("b", T0)])
  assert.deepEqual(
    two.map((i) => i.type),
    ["event", "event"],
  )
})

test("an interleaved non-mint event splits the run", () => {
  const events = [
    mint("a", T0 + 40),
    mint("b", T0 + 30),
    bid("x", T0 + 20),
    mint("c", T0 + 10),
    mint("d", T0),
  ]
  const items = groupFeedEvents(events)
  // 2 mints + bid + 2 mints → all singles (each fragment is below 3)
  assert.deepEqual(
    items.map((i) => i.type),
    ["event", "event", "event", "event", "event"],
  )
})

test("different collections never group; key includes the artist", () => {
  const events = [
    mint("a", T0 + 20, { tokenContract: "0xAAA" }),
    mint("b", T0 + 10, { tokenContract: "0xBBB" }),
    mint("c", T0, { tokenContract: "0xAAA" }),
  ]
  assert.equal(
    groupFeedEvents(events).filter((i) => i.type === "run").length,
    0,
  )

  const sharedContract = [
    mint("a", T0 + 20, { artist: "0xOne" }),
    mint("b", T0 + 10, { artist: "0xTwo" }),
    mint("c", T0, { artist: "0xOne" }),
  ]
  assert.equal(
    groupFeedEvents(sharedContract).filter((i) => i.type === "run").length,
    0,
  )
})

test("a gap above the threshold splits the run", () => {
  const events = [
    mint("a", T0 + MINT_GROUP_MAX_GAP_SECONDS * 3),
    mint("b", T0 + MINT_GROUP_MAX_GAP_SECONDS * 3 - 10),
    mint("c", T0), // far below the pair above
  ]
  const items = groupFeedEvents(events)
  assert.deepEqual(
    items.map((i) => i.type),
    ["event", "event", "event"],
  )
})

test("quantity sums into the token count", () => {
  const events = [
    mint("a", T0 + 20, { quantity: 3 }),
    mint("b", T0 + 10),
    mint("c", T0, { quantity: 2 }),
  ]
  const items = groupFeedEvents(events)
  assert.equal(items[0].type, "run")
  const run = items[0] as { type: "run"; events: Rawish[] }
  assert.equal(run.events.length, 3)
})

// ── appendFeedPage (client boundary merge) ──────────────────────────────

test("singles split across a page boundary regroup into one group", () => {
  const prev: EnrichedFeedItem[] = [single(enriched("a", T0 + 30))]
  const next: EnrichedFeedItem[] = [
    single(enriched("b", T0 + 20)),
    single(enriched("c", T0 + 10)),
  ]
  const merged = appendFeedPage(prev, next)
  assert.equal(merged.length, 1)
  const group = merged[0] as EnrichedMintGroup
  assert.equal(group.type, "group")
  assert.equal(group.mintCount, 3)
  assert.equal(group.tokenCount, 3)
  assert.equal(group.totalWei, 30n)
  assert.equal(group.blockTime, T0 + 30)
  assert.equal(group.oldestBlockTime, T0 + 10)
})

test("a group extends when the next page continues the run", () => {
  const prevGroup = buildEnrichedGroup([
    enriched("a", T0 + 40),
    enriched("b", T0 + 30),
    enriched("c", T0 + 20),
  ])
  const next: EnrichedFeedItem[] = [
    single(enriched("d", T0 + 10)),
    single(
      enriched("x", T0, {
        kind: "auction.settled",
        tokenContract: "0xOther",
        collection: null,
      }),
    ),
  ]
  const merged = appendFeedPage([prevGroup], next)
  assert.equal(merged.length, 2)
  const group = merged[0] as EnrichedMintGroup
  assert.equal(group.type, "group")
  assert.equal(group.mintCount, 4)
  assert.equal(group.oldestBlockTime, T0 + 10)
  assert.equal(merged[1].type, "event")
})

test("two singles across a boundary stay singles", () => {
  const prev: EnrichedFeedItem[] = [single(enriched("a", T0 + 10))]
  const next: EnrichedFeedItem[] = [single(enriched("b", T0))]
  const merged = appendFeedPage(prev, next)
  assert.deepEqual(
    merged.map((i) => i.type),
    ["event", "event"],
  )
})

test("boundary merge respects the gap rule", () => {
  const prev: EnrichedFeedItem[] = [
    single(enriched("a", T0 + MINT_GROUP_MAX_GAP_SECONDS * 2)),
  ]
  const next: EnrichedFeedItem[] = [
    single(enriched("b", T0 + 10)),
    single(enriched("c", T0)),
  ]
  const merged = appendFeedPage(prev, next)
  assert.deepEqual(
    merged.map((i) => i.type),
    ["event", "event", "event"],
  )
})

test("unrelated boundary items pass through untouched", () => {
  const prev: EnrichedFeedItem[] = [
    single(enriched("x", T0 + 20, { kind: "auction.bid" })),
  ]
  const next: EnrichedFeedItem[] = [single(enriched("a", T0))]
  const merged = appendFeedPage(prev, next)
  assert.equal(merged.length, 2)
})

test("minter sample dedupes and caps", () => {
  const events = [
    enriched("a", T0 + 30, { counterparty: "0xM1" }),
    enriched("b", T0 + 20, { counterparty: "0xM1" }),
    enriched("c", T0 + 10, { counterparty: "0xM2" }),
  ]
  const group = buildEnrichedGroup(events)
  assert.equal(group.minters.length, 2)
  assert.equal(group.minters[0].address, "0xM1")
})
