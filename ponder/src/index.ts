import { ponder } from "ponder:registry"
import { pndAuctions, pndBids, pndHouses } from "ponder:schema"

// Note: schema also defines fnd_* tables (auctions, bids, buy_nows, sales,
// collections, artist_tokens). Those are written by the lazy backfill
// routes in apps/web — server-side scans triggered on first cache miss
// per artist/token. Ponder doesn't index Foundation contracts directly:
// eager Layer-1 indexing of NFTMarket/FoundationNFT/factories would
// require a multi-hour backfill from block 11.9M and isn't aligned with
// the lazy strategy.

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
