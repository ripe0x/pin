import { ponder } from "ponder:registry"
import {
  pndAuctions,
  pndBids,
  pndHouses,
  fndAuctions,
  fndBids,
  fndBuyNows,
  fndSales,
  fndCollections,
  fndArtistTokens,
} from "ponder:schema"

/**
 * Event handlers for every contract Ponder is tracking. Each handler is a
 * straightforward state-machine write — no derived joins or cross-event
 * lookups needed. Bigints are stored natively because Ponder's runtime
 * supports them; the web-app reader hydrates them back from the GraphQL
 * client.
 *
 * The factory contract (SovereignAuctionHouseFactory) emits
 * `AuctionHouseCreated`. Ponder uses that event implicitly via the
 * `factory()` pattern in ponder.config.ts to discover new clones, and we
 * also write a row per house so callers can list houses without scanning
 * `pnd_auctions` (which misses houses with no listings yet).
 */

const compositeId = (house: string, auctionId: bigint) =>
  `${house.toLowerCase()}-${auctionId.toString()}`

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

ponder.on(
  "SovereignAuctionHouseFactory:AuctionHouseCreated",
  async ({ event, context }) => {
    const { owner, house, feeRecipient, protocolFeeBps } = event.args
    await context.db.insert(pndHouses).values({
      house,
      owner,
      feeRecipient,
      protocolFeeBps,
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
    })
  },
)

ponder.on("SovereignAuctionHouse:AuctionCreated", async ({ event, context }) => {
  const { auctionId, tokenId, tokenContract, duration, reservePrice, tokenOwner } =
    event.args
  const house = event.log.address

  await context.db.insert(pndAuctions).values({
    id: compositeId(house, auctionId),
    house,
    auctionId,
    tokenContract,
    tokenId,
    seller: tokenOwner,
    reservePrice,
    duration,
    amount: 0n,
    bidder: ZERO_ADDRESS,
    firstBidTime: 0n,
    endTime: 0n,
    status: "active",
    createdAtBlock: event.block.number,
    createdAtTime: event.block.timestamp,
  })
})

ponder.on("SovereignAuctionHouse:AuctionBid", async ({ event, context }) => {
  const { auctionId, bidder, amount, firstBid, extended } = event.args
  const house = event.log.address
  const id = compositeId(house, auctionId)

  // Insert the bid history entry first; if the auction row update fails for
  // any reason, we still have the immutable record on disk.
  await context.db.insert(pndBids).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    auctionId: id,
    bidder,
    amount,
    blockNumber: event.block.number,
    blockTime: event.block.timestamp,
    txHash: event.transaction.hash,
    firstBid,
    extended,
  })

  // Update live auction state. We need the row's existing `firstBidTime`
  // and `duration` to compute `endTime` correctly when this is *not* the
  // first bid (extension) — Ponder's `update` lets us pass a function that
  // receives the current row.
  await context.db.update(pndAuctions, { id }).set((row) => {
    const firstBidTime = firstBid ? event.block.timestamp : row.firstBidTime
    // endTime = firstBidTime + duration, possibly extended on late bids.
    // The contract's own AuctionEndTimeUpdated event handler below
    // overwrites this if the late-bid extension applied.
    const endTime = firstBid
      ? firstBidTime + row.duration
      : extended
        ? row.endTime // will be corrected by AuctionEndTimeUpdated
        : row.endTime
    return {
      amount,
      bidder,
      firstBidTime,
      endTime,
    }
  })
})

ponder.on(
  "SovereignAuctionHouse:AuctionEndTimeUpdated",
  async ({ event, context }) => {
    const { auctionId, newEndTime } = event.args
    const house = event.log.address
    await context.db
      .update(pndAuctions, { id: compositeId(house, auctionId) })
      .set({ endTime: newEndTime })
  },
)

ponder.on(
  "SovereignAuctionHouse:AuctionReservePriceUpdated",
  async ({ event, context }) => {
    const { auctionId, reservePrice } = event.args
    const house = event.log.address
    await context.db
      .update(pndAuctions, { id: compositeId(house, auctionId) })
      .set({ reservePrice })
  },
)

ponder.on("SovereignAuctionHouse:AuctionEnded", async ({ event, context }) => {
  const { auctionId, winner, sellerProceeds, protocolFee } = event.args
  const house = event.log.address
  await context.db
    .update(pndAuctions, { id: compositeId(house, auctionId) })
    .set({
      status: "settled",
      winner,
      sellerProceeds,
      protocolFee,
      settledAtBlock: event.block.number,
      settledAtTime: event.block.timestamp,
    })
})

ponder.on(
  "SovereignAuctionHouse:AuctionCanceled",
  async ({ event, context }) => {
    const { auctionId } = event.args
    const house = event.log.address
    await context.db
      .update(pndAuctions, { id: compositeId(house, auctionId) })
      .set({
        status: "cancelled",
        settledAtBlock: event.block.number,
        settledAtTime: event.block.timestamp,
      })
  },
)

// ─── Foundation NFTMarket ────────────────────────────────────────────────
// Single-contract event stream: all Foundation reserve auctions and buy-now
// listings live here. We deliberately skip Offer* events for now — the web
// app's cost-driver paths (last-sale, bid history, seller-cancellable
// listings) don't need them, and event volume on Foundation is low enough
// that adding them later is cheap.

ponder.on("NFTMarket:ReserveAuctionCreated", async ({ event, context }) => {
  const { seller, nftContract, tokenId, duration, reservePrice, auctionId } =
    event.args
  await context.db
    .insert(fndAuctions)
    .values({
      auctionId,
      nftContract,
      tokenId,
      seller,
      reservePrice,
      durationSeconds: duration,
      highestBid: 0n,
      highestBidder: null,
      endTime: 0n,
      status: "active",
      createdAtBlock: event.block.number,
      createdAtTime: event.block.timestamp,
    })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:ReserveAuctionBidPlaced", async ({ event, context }) => {
  const { auctionId, bidder, amount, endTime } = event.args
  // Insert the immutable bid log unconditionally. The auction-row update
  // below is guarded against missing rows (auction predates index window).
  await context.db
    .insert(fndBids)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      auctionId,
      bidder,
      amount,
      endTime,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
  const existing = await context.db.find(fndAuctions, { auctionId })
  if (!existing) return
  await context.db.update(fndAuctions, { auctionId }).set({
    highestBid: amount,
    highestBidder: bidder,
    endTime,
  })
})

ponder.on("NFTMarket:ReserveAuctionFinalized", async ({ event, context }) => {
  const { auctionId, seller, bidder, totalFees, creatorRev, sellerRev } =
    event.args
  const auction = await context.db.find(fndAuctions, { auctionId })
  // Skip finalizations for auctions that predate our index window — we
  // can't recover (nftContract, tokenId) without the create event.
  if (!auction) return

  await context.db.update(fndAuctions, { auctionId }).set({
    status: "finalized",
    finalizedTotalFees: totalFees,
    finalizedCreatorRev: creatorRev,
    finalizedSellerRev: sellerRev,
    finalizedAtTime: event.block.timestamp,
    finalizedTxHash: event.transaction.hash,
  })

  await context.db
    .insert(fndSales)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      nftContract: auction.nftContract,
      tokenId: auction.tokenId,
      seller,
      buyer: bidder,
      priceWei: totalFees + creatorRev + sellerRev,
      source: "auction",
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:ReserveAuctionCanceled", async ({ event, context }) => {
  const { auctionId } = event.args
  const existing = await context.db.find(fndAuctions, { auctionId })
  if (!existing) return
  await context.db
    .update(fndAuctions, { auctionId })
    .set({ status: "canceled" })
})

ponder.on("NFTMarket:ReserveAuctionUpdated", async ({ event, context }) => {
  const { auctionId, reservePrice } = event.args
  const existing = await context.db.find(fndAuctions, { auctionId })
  if (!existing) return
  await context.db
    .update(fndAuctions, { auctionId })
    .set({ reservePrice })
})

ponder.on(
  "NFTMarket:ReserveAuctionInvalidated",
  async ({ event, context }) => {
    const { auctionId } = event.args
    const existing = await context.db.find(fndAuctions, { auctionId })
    if (!existing) return
    await context.db
      .update(fndAuctions, { auctionId })
      .set({ status: "invalidated" })
  },
)

const buyNowId = (nftContract: string, tokenId: bigint) =>
  `${nftContract.toLowerCase()}-${tokenId.toString()}`

ponder.on("NFTMarket:BuyPriceSet", async ({ event, context }) => {
  const { nftContract, tokenId, seller, price } = event.args
  const id = buyNowId(nftContract, tokenId)
  // BuyPriceSet fires both on initial set and on price update. The contract
  // only allows one active buy-now per token, so the row is upserted.
  await context.db
    .insert(fndBuyNows)
    .values({
      id,
      nftContract,
      tokenId,
      seller,
      price,
      status: "active",
      createdAtTime: event.block.timestamp,
    })
    .onConflictDoUpdate(() => ({
      seller,
      price,
      status: "active",
      updatedAtTime: event.block.timestamp,
    }))
})

ponder.on("NFTMarket:BuyPriceCanceled", async ({ event, context }) => {
  const { nftContract, tokenId } = event.args
  const id = buyNowId(nftContract, tokenId)
  const existing = await context.db.find(fndBuyNows, { id })
  if (!existing) return
  await context.db
    .update(fndBuyNows, { id })
    .set({ status: "canceled", updatedAtTime: event.block.timestamp })
})

ponder.on("NFTMarket:BuyPriceAccepted", async ({ event, context }) => {
  const {
    nftContract,
    tokenId,
    seller,
    buyer,
    totalFees,
    creatorRev,
    sellerRev,
  } = event.args
  const id = buyNowId(nftContract, tokenId)
  const priceWei = totalFees + creatorRev + sellerRev
  const existing = await context.db.find(fndBuyNows, { id })

  if (existing) {
    await context.db.update(fndBuyNows, { id }).set({
      status: "accepted",
      updatedAtTime: event.block.timestamp,
      acceptedBuyer: buyer,
      acceptedTxHash: event.transaction.hash,
      acceptedTotalFees: totalFees,
      acceptedCreatorRev: creatorRev,
      acceptedSellerRev: sellerRev,
    })
  }

  // Sale row goes in regardless of whether the buyNow row was indexed —
  // last-sale only needs the sale stream, not the listing context.
  await context.db
    .insert(fndSales)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      nftContract,
      tokenId,
      seller,
      buyer,
      priceWei,
      source: "buyNow",
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:BuyPriceInvalidated", async ({ event, context }) => {
  const { nftContract, tokenId } = event.args
  const id = buyNowId(nftContract, tokenId)
  const existing = await context.db.find(fndBuyNows, { id })
  if (!existing) return
  await context.db
    .update(fndBuyNows, { id })
    .set({ status: "invalidated", updatedAtTime: event.block.timestamp })
})

// ─── Foundation shared 1/1 NFT contract ──────────────────────────────────
// Every artist mint on `0x3B3ee...` lands as a Minted event keyed by
// (creator, tokenId). We write to fnd_artist_tokens so the artist gallery
// can list shared-contract tokens via a `WHERE creator = $1` query.

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const

const FOUNDATION_NFT_ADDRESS =
  "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405" as const

const tokenRefId = (contract: string, tokenId: bigint) =>
  `${contract.toLowerCase()}-${tokenId.toString()}`

ponder.on("FoundationNFT:Minted", async ({ event, context }) => {
  const { creator, tokenId } = event.args
  await context.db
    .insert(fndArtistTokens)
    .values({
      id: tokenRefId(FOUNDATION_NFT_ADDRESS, tokenId),
      creator,
      contract: FOUNDATION_NFT_ADDRESS,
      tokenId,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      blockTime: event.block.timestamp,
    })
    .onConflictDoNothing()
})

// ─── Foundation collection factories (V1 + V2) ───────────────────────────
// Every per-artist collection contract emitted by either factory is
// recorded here, plus the Ponder factory() pattern in ponder.config.ts
// hooks each new contract up to FoundationCollection's Transfer handler
// below.

ponder.on(
  "FoundationCollectionFactoryV1:NFTCollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection,
        creator,
        kind: "1of1",
        name,
        symbol,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "FoundationCollectionFactoryV1:CollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection,
        creator,
        kind: "1of1",
        name,
        symbol,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "FoundationCollectionFactoryV1:NFTDropCollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection,
        creator,
        kind: "drop",
        name,
        symbol,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "FoundationCollectionFactoryV2:NFTCollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection,
        creator,
        kind: "1of1",
        name,
        symbol,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "FoundationCollectionFactoryV2:CollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection,
        creator,
        kind: "1of1",
        name,
        symbol,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "FoundationCollectionFactoryV2:NFTDropCollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection,
        creator,
        kind: "drop",
        name,
        symbol,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

// ─── Per-artist Foundation collection contracts ──────────────────────────
// Three contract entries (modern / legacy / drop) all run the same handler
// because the source address comes from `event.log.address` and writes are
// idempotent. We only persist Transfer-from-zero (mints); the `to` address
// is the artist (the artist mints to themselves first).

ponder.on(
  "FoundationCollectionViaModern:Transfer",
  async ({ event, context }) => {
    const { from, to, tokenId } = event.args
    if (from !== ZERO_ADDR) return
    const collection = event.log.address
    await context.db
      .insert(fndArtistTokens)
      .values({
        id: tokenRefId(collection, tokenId),
        creator: to,
        contract: collection,
        tokenId,
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
        blockTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "FoundationCollectionViaLegacy:Transfer",
  async ({ event, context }) => {
    const { from, to, tokenId } = event.args
    if (from !== ZERO_ADDR) return
    const collection = event.log.address
    await context.db
      .insert(fndArtistTokens)
      .values({
        id: tokenRefId(collection, tokenId),
        creator: to,
        contract: collection,
        tokenId,
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
        blockTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "FoundationCollectionViaDrop:Transfer",
  async ({ event, context }) => {
    const { from, to, tokenId } = event.args
    if (from !== ZERO_ADDR) return
    const collection = event.log.address
    await context.db
      .insert(fndArtistTokens)
      .values({
        id: tokenRefId(collection, tokenId),
        creator: to,
        contract: collection,
        tokenId,
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
        blockTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)
