import { ponder } from "ponder:registry"
import { pndAuctions, pndBids, pndHouses } from "ponder:schema"

/**
 * Sovereign Auction House V2 handlers — DEPLOY-GATED.
 *
 * V2 houses write into the same pnd_houses / pnd_auctions / pnd_bids
 * tables as V1, distinguished by `version: 2`. The V1 lifecycle events
 * (AuctionCreated/Bid/EndTimeUpdated/ReservePriceUpdated/Ended/Canceled)
 * are handled identically. V2 adds:
 *
 *   Auction1155Created   — ERC1155 lot (row carries `quantity`)
 *   AuctionEndedToEscrow — settlement paid out with the lot held for the
 *                          winner; status "escrowed"
 *   EscrowedLotDelivered — escrowed lot delivered; status "settled"
 *   AuctionDeliveryFailed — mutual-consent unwind; status "failed"
 *   AuctionDurationUpdated — pre-bid duration change
 *
 * Not indexed (no read path needs them yet): AuctionFundsRecipientUpdated,
 * AuctionListingExpiryUpdated, UnwindConsentRecorded, FailedLotReturned,
 * RefundCredited/RefundWithdrawn. The migrate flow reads listing settings
 * on-chain at click time, not from these rows.
 */

const compositeId = (house: string, auctionId: bigint) =>
  `${house.toLowerCase()}-${auctionId.toString()}`

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

type Hex = `0x${string}`

// Registration gate, matching ponder.config.ts's SOVEREIGN_V2_WIRED (same
// two env vars — not imported to keep this file free of config imports).
// Registering a handler for an event name absent from `contracts` is a
// Ponder BUILD ERROR, so with the env unset these registrations must not
// run at all. Same boundary-widening pattern as src/Homage.ts: the
// deploy-gated names aren't in the generated registry types until the env
// is set at codegen time.
const SOVEREIGN_V2_WIRED = Boolean(
  process.env.SOVEREIGN_V2_FACTORY_ADDRESS &&
    process.env.SOVEREIGN_V2_FACTORY_START_BLOCK,
)
type GatedIndexingFunction = (args: {
  event: any
  context: any
}) => Promise<void> | void
const on: (name: string, fn: GatedIndexingFunction) => void = SOVEREIGN_V2_WIRED
  ? (ponder.on.bind(ponder) as unknown as (
      name: string,
      fn: GatedIndexingFunction,
    ) => void)
  : () => {}

on("SovereignAuctionHouseV2Factory:AuctionHouseCreated", async ({ event, context }) => {
  const { owner, house, feeRecipient, protocolFeeBps } = event.args as {
    owner: Hex
    house: Hex
    feeRecipient: Hex
    protocolFeeBps: number
  }
  await context.db.insert(pndHouses).values({
    house,
    owner,
    feeRecipient,
    protocolFeeBps,
    version: 2,
    createdAtBlock: event.block.number,
    createdAtTime: event.block.timestamp,
    createdTxHash: event.transaction.hash,
  })
})

on("SovereignAuctionHouseV2:AuctionCreated", async ({ event, context }) => {
  const { auctionId, tokenId, tokenContract, duration, reservePrice, tokenOwner } =
    event.args as {
      auctionId: bigint
      tokenId: bigint
      tokenContract: Hex
      duration: bigint
      reservePrice: bigint
      tokenOwner: Hex
    }
  const house = event.log.address as Hex
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
    version: 2,
    standard: "erc721",
    quantity: 1n,
    createdAtBlock: event.block.number,
    createdAtTime: event.block.timestamp,
    createdTxHash: event.transaction.hash,
  })
})

on("SovereignAuctionHouseV2:Auction1155Created", async ({ event, context }) => {
  const { auctionId, tokenId, tokenContract, quantity, duration, reservePrice, tokenOwner } =
    event.args as {
      auctionId: bigint
      tokenId: bigint
      tokenContract: Hex
      quantity: bigint
      duration: bigint
      reservePrice: bigint
      tokenOwner: Hex
    }
  const house = event.log.address as Hex
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
    version: 2,
    standard: "erc1155",
    quantity,
    createdAtBlock: event.block.number,
    createdAtTime: event.block.timestamp,
    createdTxHash: event.transaction.hash,
  })
})

// Find-or-skip on every per-auction update handler, same as src/index.ts:
// Ponder's factory pattern can briefly drop a clone out of
// factory_addresses; a later event for an auction whose create we never
// captured must not crash the indexer.

on("SovereignAuctionHouseV2:AuctionBid", async ({ event, context }) => {
  const { auctionId, bidder, amount, firstBid, extended } = event.args as {
    auctionId: bigint
    bidder: Hex
    amount: bigint
    firstBid: boolean
    extended: boolean
  }
  const house = event.log.address as Hex
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

  await context.db.update(pndAuctions, { id }).set((row: typeof pndAuctions.$inferSelect) => {
    const firstBidTime = firstBid ? event.block.timestamp : row.firstBidTime
    const endTime = firstBid ? firstBidTime + row.duration : row.endTime
    return { amount, bidder, firstBidTime, endTime }
  })
})

on("SovereignAuctionHouseV2:AuctionEndTimeUpdated", async ({ event, context }) => {
  const { auctionId, newEndTime } = event.args as {
    auctionId: bigint
    newEndTime: bigint
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({ endTime: newEndTime })
})

on("SovereignAuctionHouseV2:AuctionReservePriceUpdated", async ({ event, context }) => {
  const { auctionId, reservePrice } = event.args as {
    auctionId: bigint
    reservePrice: bigint
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({ reservePrice })
})

on("SovereignAuctionHouseV2:AuctionDurationUpdated", async ({ event, context }) => {
  const { auctionId, duration } = event.args as {
    auctionId: bigint
    duration: bigint
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({ duration })
})

on("SovereignAuctionHouseV2:AuctionEnded", async ({ event, context }) => {
  const { auctionId, winner, sellerProceeds, protocolFee } = event.args as {
    auctionId: bigint
    winner: Hex
    sellerProceeds: bigint
    protocolFee: bigint
  }
  const id = compositeId(event.log.address as Hex, auctionId)
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

on("SovereignAuctionHouseV2:AuctionEndedToEscrow", async ({ event, context }) => {
  const { auctionId, winner, sellerProceeds, protocolFee } = event.args as {
    auctionId: bigint
    tokenOwner: Hex
    winner: Hex
    sellerProceeds: bigint
    protocolFee: bigint
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "escrowed",
    winner,
    sellerProceeds,
    protocolFee,
    settledAtBlock: event.block.number,
    settledAtTime: event.block.timestamp,
    lifecycleTxHash: event.transaction.hash,
  })
})

on("SovereignAuctionHouseV2:EscrowedLotDelivered", async ({ event, context }) => {
  const { auctionId } = event.args as { auctionId: bigint; winner: Hex }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "settled",
    lifecycleTxHash: event.transaction.hash,
  })
})

on("SovereignAuctionHouseV2:AuctionDeliveryFailed", async ({ event, context }) => {
  const { auctionId } = event.args as {
    auctionId: bigint
    winner: Hex
    refundAmount: bigint
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "failed",
    settledAtBlock: event.block.number,
    settledAtTime: event.block.timestamp,
    lifecycleTxHash: event.transaction.hash,
  })
})

on("SovereignAuctionHouseV2:AuctionCanceled", async ({ event, context }) => {
  const { auctionId } = event.args as { auctionId: bigint }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "cancelled",
    settledAtBlock: event.block.number,
    settledAtTime: event.block.timestamp,
    lifecycleTxHash: event.transaction.hash,
  })
})
