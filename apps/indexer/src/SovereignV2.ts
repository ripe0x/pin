import { ponder } from "ponder:registry"
import { pndAuctions, pndBids, pndHouses } from "ponder:schema"
import { resolveLotUnwoundStatus } from "./sovereignV2Status"

/**
 * Sovereign Auction House V2 handlers — DEPLOY-GATED.
 *
 * V2 houses write into the same pnd_houses / pnd_auctions / pnd_bids
 * tables as V1, distinguished by `version: 2`. The V1 lifecycle events
 * (AuctionCreated/Bid/EndTimeUpdated/ReservePriceUpdated/Ended/Canceled)
 * are handled the same way, plus the V2-only fields (fundsRecipient,
 * listingExpiry) each event now carries.
 *
 * V2 settlement is escrow-and-wait, not escrow-and-hold: endAuction pays
 * the seller only after delivery to the winner is verified. A failed
 * delivery pays nobody and moves the row to "deferred"; claimLot or
 * unwindStuckLot's retry can still settle it later, which is why
 * AuctionEnded (not a separate "delivered" event) is the one handler that
 * always finalizes a row to "settled", it fires from every successful
 * delivery path, immediate or deferred.
 *
 * Status state machine (see the `status` column comment on pndAuctions
 * in ponder.schema.ts for the full value list):
 *   AuctionCreated / Auction1155Created -> active
 *   AuctionEnded                        -> settled (terminal)
 *   DeliveryDeferred                    -> deferred
 *   LotClaimed                          -> claim metadata only; the
 *                                          AuctionEnded emitted in the
 *                                          same call already set settled
 *   LotUnwound                          -> unwound, unless a
 *                                          LotReturnDeferred in the same
 *                                          call already set
 *                                          unwound_return_pending
 *   LotReturnDeferred                   -> unwound_return_pending
 *   LotReturned                         -> unwound (terminal)
 *   AuctionCanceled                     -> cancelled (terminal)
 *
 * Not indexed (no read path needs them; RefundCredited/RefundWithdrawn
 * have no dedicated table and LotUnwound already carries refundAmount):
 * RefundCredited, RefundWithdrawn, StuckERC721Recovered,
 * StuckERC1155Recovered.
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
  const { auctionId, tokenId, tokenContract, duration, reservePrice, tokenOwner, fundsRecipient, listingExpiry } =
    event.args as {
      auctionId: bigint
      tokenId: bigint
      tokenContract: Hex
      duration: bigint
      reservePrice: bigint
      tokenOwner: Hex
      fundsRecipient: Hex
      listingExpiry: bigint
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
    fundsRecipient,
    listingExpiry,
    createdAtBlock: event.block.number,
    createdAtTime: event.block.timestamp,
    createdTxHash: event.transaction.hash,
  })
})

on("SovereignAuctionHouseV2:Auction1155Created", async ({ event, context }) => {
  const {
    auctionId,
    tokenId,
    tokenContract,
    quantity,
    duration,
    reservePrice,
    tokenOwner,
    fundsRecipient,
    listingExpiry,
  } = event.args as {
    auctionId: bigint
    tokenId: bigint
    tokenContract: Hex
    quantity: bigint
    duration: bigint
    reservePrice: bigint
    tokenOwner: Hex
    fundsRecipient: Hex
    listingExpiry: bigint
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
    fundsRecipient,
    listingExpiry,
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

on("SovereignAuctionHouseV2:AuctionFundsRecipientUpdated", async ({ event, context }) => {
  const { auctionId, fundsRecipient } = event.args as {
    auctionId: bigint
    fundsRecipient: Hex
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({ fundsRecipient })
})

on("SovereignAuctionHouseV2:AuctionListingExpiryUpdated", async ({ event, context }) => {
  const { auctionId, listingExpiry } = event.args as {
    auctionId: bigint
    listingExpiry: bigint
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({ listingExpiry })
})

// Always fires on a successful delivery, whether that happens immediately
// (endAuction) or later via a deferred retry (claimLot,
// unwindStuckLot's retry-to-winner), _finalizeSale emits this from every
// success path, so this handler is the single place a row becomes
// "settled".
on("SovereignAuctionHouseV2:AuctionEnded", async ({ event, context }) => {
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
    status: "settled",
    winner,
    sellerProceeds,
    protocolFee,
    settledAtBlock: event.block.number,
    settledAtTime: event.block.timestamp,
    lifecycleTxHash: event.transaction.hash,
  })
})

// Delivery to the winner failed during endAuction. Nobody is paid; the
// bid and lot stay escrowed for a permissionless claimLot retry.
on("SovereignAuctionHouseV2:DeliveryDeferred", async ({ event, context }) => {
  const { auctionId, winner } = event.args as {
    auctionId: bigint
    winner: Hex
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "deferred",
    winner,
    deferredAtTime: event.block.timestamp,
  })
})

// Fires alongside AuctionEnded in the same tx (claimLot or
// unwindStuckLot's retry-to-winner both call _finalizeSale, which emits
// AuctionEnded, before emitting this). Only records claim metadata, the
// AuctionEnded handler above already moved status to "settled".
on("SovereignAuctionHouseV2:LotClaimed", async ({ event, context }) => {
  const { auctionId, recipient } = event.args as {
    auctionId: bigint
    winner: Hex
    recipient: Hex
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "settled",
    claimedAtBlock: event.block.number,
    claimedAtTime: event.block.timestamp,
    claimTxHash: event.transaction.hash,
    claimRecipient: recipient,
  })
})

// unwindStuckLot's retry-to-winner also failed: the sale unwinds. The
// winner's full bid is credited to pendingRefunds; the lot returns to the
// seller in the same call, or if that return also fails,
// LotReturnDeferred fires in the same tx (before this event, per the
// contract's emit order) and sets unwound_return_pending. Re-read the row
// so that ordering is never clobbered back to "unwound" regardless of
// which of the two fires first.
on("SovereignAuctionHouseV2:LotUnwound", async ({ event, context }) => {
  const { auctionId, winner, refundAmount } = event.args as {
    auctionId: bigint
    winner: Hex
    refundAmount: bigint
    tokenOwner: Hex
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  const status = resolveLotUnwoundStatus(existing.status)
  await context.db.update(pndAuctions, { id }).set({
    status,
    winner,
    refundAmount,
  })
})

on("SovereignAuctionHouseV2:LotReturnDeferred", async ({ event, context }) => {
  const { auctionId } = event.args as {
    auctionId: bigint
    tokenOwner: Hex
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "unwound_return_pending",
  })
})

on("SovereignAuctionHouseV2:LotReturned", async ({ event, context }) => {
  const { auctionId } = event.args as {
    auctionId: bigint
    tokenOwner: Hex
  }
  const id = compositeId(event.log.address as Hex, auctionId)
  const existing = await context.db.find(pndAuctions, { id })
  if (!existing) return
  await context.db.update(pndAuctions, { id }).set({
    status: "unwound",
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
