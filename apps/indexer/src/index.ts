import { ponder } from "ponder:registry"
import {
  pndAuctions,
  pndBids,
  pndHouses,
  fndArtistTokens,
  fndAuctions,
  fndBids,
  fndBuyNows,
  fndCollections,
  fndSales,
} from "ponder:schema"

/**
 * Event handlers for the v2 Ponder scope. State-machine subscriptions
 * only: PND auctions + Foundation NFTMarket + Foundation shared 1/1 +
 * Foundation collection-factory discovery.
 *
 * Per-clone Transfer subscriptions (FoundationCollection, MintCollection,
 * TLCollection) and the SR Bazaar + TL Auction House marketplaces are
 * intentionally NOT subscribed here in v2 — that work lives in the
 * worker (apps/worker/src/tasks/scan-{fnd-collections,mint-clones,
 * tl-clones}.ts).
 *
 * Discovery-only handlers for MintFactory, TLUniversalDeployer, and
 * Catalog live in their per-contract files.
 */

const compositeId = (house: string, auctionId: bigint) =>
  `${house.toLowerCase()}-${auctionId.toString()}`

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

// ─── PND: SovereignAuctionHouseFactory ───────────────────────────────────

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
      createdTxHash: event.transaction.hash,
    })
  },
)

// ─── PND: SovereignAuctionHouse (per-clone via factory pattern) ──────────

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
    createdTxHash: event.transaction.hash,
  })
})

// Find-or-skip on every per-auction update handler below: Ponder 0.16's
// factory pattern can briefly drop a clone out of factory_addresses,
// so a later AuctionBid for an auction whose AuctionCreated we never
// captured shouldn't crash the indexer. The bid itself is still
// preserved in pnd_bids (immutable history). The worker's
// ponder-drift-check task forward-fixes the underlying gap.

ponder.on("SovereignAuctionHouse:AuctionBid", async ({ event, context }) => {
  const { auctionId, bidder, amount, firstBid, extended } = event.args
  const house = event.log.address
  const id = compositeId(house, auctionId)

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

  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return

  await context.db.update(pndAuctions, { id }).set((row) => {
    const firstBidTime = firstBid ? event.block.timestamp : row.firstBidTime
    const endTime = firstBid
      ? firstBidTime + row.duration
      : extended
        ? row.endTime
        : row.endTime
    return { amount, bidder, firstBidTime, endTime }
  })
})

ponder.on(
  "SovereignAuctionHouse:AuctionEndTimeUpdated",
  async ({ event, context }) => {
    const { auctionId, newEndTime } = event.args
    const id = compositeId(event.log.address, auctionId)
    const existing = await context.db.find(pndAuctions, { id })
    if (!existing) return
    await context.db.update(pndAuctions, { id }).set({ endTime: newEndTime })
  },
)

ponder.on(
  "SovereignAuctionHouse:AuctionReservePriceUpdated",
  async ({ event, context }) => {
    const { auctionId, reservePrice } = event.args
    const id = compositeId(event.log.address, auctionId)
    const existing = await context.db.find(pndAuctions, { id })
    if (!existing) return
    await context.db.update(pndAuctions, { id }).set({ reservePrice })
  },
)

ponder.on("SovereignAuctionHouse:AuctionEnded", async ({ event, context }) => {
  const { auctionId, winner, sellerProceeds, protocolFee } = event.args
  const id = compositeId(event.log.address, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "settled",
    winner,
    sellerProceeds,
    protocolFee,
    settledAtBlock: event.block.number,
    settledAtTime: event.block.timestamp,
    lifecycleTxHash: event.transaction.hash,
  })
})

ponder.on(
  "SovereignAuctionHouse:AuctionCanceled",
  async ({ event, context }) => {
    const { auctionId } = event.args
    const id = compositeId(event.log.address, auctionId)
    const existing = await context.db.find(pndAuctions, { id })
    if (!existing) return
    await context.db.update(pndAuctions, { id }).set({
      status: "cancelled",
      settledAtBlock: event.block.number,
      settledAtTime: event.block.timestamp,
      lifecycleTxHash: event.transaction.hash,
    })
  },
)

// ─── Foundation shared 1/1 (FoundationNFT) ───────────────────────────────

ponder.on("FoundationNFT:Minted", async ({ event, context }) => {
  const { creator, tokenId } = event.args
  const contract = event.log.address
  await context.db
    .insert(fndArtistTokens)
    .values({
      id: `${contract.toLowerCase()}-${tokenId.toString()}`,
      creator,
      contract,
      tokenId,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      blockTime: event.block.timestamp,
    })
    .onConflictDoNothing()
})

// ─── Foundation NFTMarket — reserve auctions ────────────────────────────

ponder.on("NFTMarket:ReserveAuctionCreated", async ({ event, context }) => {
  const { seller, nftContract, tokenId, duration, reservePrice, auctionId } =
    event.args
  await context.db.insert(fndAuctions).values({
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
})

ponder.on("NFTMarket:ReserveAuctionBidPlaced", async ({ event, context }) => {
  const { auctionId, bidder, amount, endTime } = event.args
  const auction = await context.db.find(fndAuctions, { auctionId })
  if (!auction) return
  await context.db.insert(fndBids).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    auctionId,
    bidder,
    amount,
    endTime,
    blockNumber: event.block.number,
    blockTime: event.block.timestamp,
    txHash: event.transaction.hash,
  })
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
  const auction = await context.db.find(fndAuctions, { auctionId })
  if (!auction) return
  await context.db.update(fndAuctions, { auctionId }).set({
    status: "canceled",
    finalizedAtTime: event.block.timestamp,
    finalizedTxHash: event.transaction.hash,
  })
})

ponder.on("NFTMarket:ReserveAuctionUpdated", async ({ event, context }) => {
  const { auctionId, reservePrice } = event.args
  const auction = await context.db.find(fndAuctions, { auctionId })
  if (!auction) return
  await context.db.update(fndAuctions, { auctionId }).set({ reservePrice })
})

ponder.on(
  "NFTMarket:ReserveAuctionInvalidated",
  async ({ event, context }) => {
    const { auctionId } = event.args
    const auction = await context.db.find(fndAuctions, { auctionId })
    if (!auction) return
    await context.db.update(fndAuctions, { auctionId }).set({
      status: "invalidated",
      finalizedAtTime: event.block.timestamp,
      finalizedTxHash: event.transaction.hash,
    })
  },
)

// ─── Foundation NFTMarket — buy now ──────────────────────────────────────

ponder.on("NFTMarket:BuyPriceSet", async ({ event, context }) => {
  const { nftContract, tokenId, seller, price } = event.args
  const id = `${nftContract.toLowerCase()}-${tokenId.toString()}`
  const existing = await context.db.find(fndBuyNows, { id })
  if (existing) {
    await context.db.update(fndBuyNows, { id }).set({
      seller, price, status: "active",
      updatedAtTime: event.block.timestamp,
      acceptedBuyer: null,
      acceptedTxHash: null,
      acceptedTotalFees: null,
      acceptedCreatorRev: null,
      acceptedSellerRev: null,
    })
  } else {
    await context.db.insert(fndBuyNows).values({
      id, nftContract, tokenId, seller, price,
      status: "active",
      createdAtTime: event.block.timestamp,
    })
  }
})

ponder.on("NFTMarket:BuyPriceCanceled", async ({ event, context }) => {
  const { nftContract, tokenId } = event.args
  const id = `${nftContract.toLowerCase()}-${tokenId.toString()}`
  const existing = await context.db.find(fndBuyNows, { id })
  if (!existing) return
  await context.db.update(fndBuyNows, { id }).set({
    status: "canceled",
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("NFTMarket:BuyPriceAccepted", async ({ event, context }) => {
  const { nftContract, tokenId, seller, buyer, totalFees, creatorRev, sellerRev } =
    event.args
  const id = `${nftContract.toLowerCase()}-${tokenId.toString()}`
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
  await context.db
    .insert(fndSales)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      nftContract, tokenId, seller, buyer,
      priceWei: totalFees + creatorRev + sellerRev,
      source: "buyNow",
      blockTime: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on("NFTMarket:BuyPriceInvalidated", async ({ event, context }) => {
  const { nftContract, tokenId } = event.args
  const id = `${nftContract.toLowerCase()}-${tokenId.toString()}`
  const existing = await context.db.find(fndBuyNows, { id })
  if (!existing) return
  await context.db.update(fndBuyNows, { id }).set({
    status: "invalidated",
    updatedAtTime: event.block.timestamp,
  })
})

// ─── Foundation collection factories (DISCOVERY-ONLY) ───────────────────
// Per-clone Transfer subscriptions are NOT registered in v2; the worker
// task `scan-fnd-collections` reads these rows and scans the clones
// itself, cursor-bounded, gated by known_artists.

ponder.on(
  "NFTCollectionFactoryV1:NFTCollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection, creator, kind: "1of1",
        name: name || null,
        symbol: symbol || null,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)

ponder.on(
  "NFTCollectionFactoryV2:NFTCollectionCreated",
  async ({ event, context }) => {
    const { collection, creator, name, symbol } = event.args
    await context.db
      .insert(fndCollections)
      .values({
        collection, creator, kind: "1of1",
        name: name || null,
        symbol: symbol || null,
        createdAtBlock: event.block.number,
        createdAtTime: event.block.timestamp,
      })
      .onConflictDoNothing()
  },
)
