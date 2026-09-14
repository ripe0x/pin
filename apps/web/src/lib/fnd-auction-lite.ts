import type { SovereignAuctionLite } from "./auctions"

/**
 * Shape a Foundation reserve auction into the `SovereignAuctionLite` the
 * artist gallery already consumes (badge + sort). Pure — no DB/chain — so
 * it is unit-tested directly. `SovereignAuctionLite` has no first-bid
 * timestamp field of its own; the gallery only needs `bucket`, which is
 * derived here, so `firstBidTime` carries a 0/non-zero sentinel.
 *
 * Foundation's on-chain `amount` is the reserve until the first bid, then
 * the high bid; callers pass the reserve separately so the caption can
 * show "reserve" while listed and the live bid once bidding starts.
 */
export function toFndAuctionLite(input: {
  auctionId: string
  reserveWei: string
  highestBidWei: string
  hasBidder: boolean
  endTime: number
  nowSec: number
}): SovereignAuctionLite {
  const awaitingFirstBid = !input.hasBidder || input.endTime === 0
  const bucket: SovereignAuctionLite["bucket"] = awaitingFirstBid
    ? "listed"
    : input.endTime > input.nowSec
      ? "active"
      : "ending"
  return {
    auctionId: input.auctionId,
    amount: awaitingFirstBid ? input.reserveWei : input.highestBidWei,
    reservePrice: input.reserveWei,
    endTime: String(input.endTime),
    firstBidTime: awaitingFirstBid ? "0" : String(input.endTime),
    bucket,
  }
}
