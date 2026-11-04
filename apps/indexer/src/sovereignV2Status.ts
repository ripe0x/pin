/**
 * Pure V2 auction status-transition helpers, split out of SovereignV2.ts so
 * they can be unit tested directly, SovereignV2.ts imports the
 * "ponder:registry"/"ponder:schema" virtual modules, which only resolve
 * inside a running Ponder build, not a standalone test runner.
 */

/**
 * `version` written to pnd_houses and pnd_auctions per house generation.
 * V2.1 houses get their own value rather than 2: their `auctionVersion()`
 * still returns 2 (same Auction tuple and ABI, so V2 readers work
 * unchanged), but settlement differs (LotHeldForWinner), and the factory a
 * house came from is the only on-chain discriminator besides `version()`.
 * 21 keeps "major 2" readable (`version >= 2` is "V2-compatible") while
 * staying an integer column.
 */
export const HOUSE_VERSION = {
  V1: 1,
  V2: 2,
  V2_1: 21,
} as const

/**
 * Status a V2.1 lot holds after LotHeldForWinner: the sale settled (protocol
 * fee and seller paid, AuctionEnded fired first in the same call) but
 * delivery to the winner failed while the lot stayed transferable, so the
 * lot is escrowed in the house until the winner calls claimLot(id, to).
 * No deadline and no refund path; LotClaimed moves it to "settled".
 */
export const HELD_FOR_WINNER = "held_for_winner" as const

/**
 * Decides the status AuctionEnded should write. endAuction (and V2.1's
 * unwindStuckLot) emit AuctionEnded and then LotHeldForWinner in the same
 * call when the lot is held for the winner. Ponder processes them in log
 * order, so AuctionEnded normally sees a pre-settlement status; keeping
 * "held_for_winner" if it is already there makes the outcome independent of
 * processing order. A held lot can never emit a second AuctionEnded on
 * chain (endAuction reverts AuctionAlreadySettled, claimLot on a held lot
 * emits only LotClaimed), so this never masks a real settlement.
 */
export function resolveAuctionEndedStatus(
  currentStatus: string,
): "settled" | typeof HELD_FOR_WINNER {
  return currentStatus === HELD_FOR_WINNER ? HELD_FOR_WINNER : "settled"
}

/**
 * Decides the status LotHeldForWinner should write. A row whose claim was
 * already recorded (claimLot in a later call of the same transaction,
 * processed out of order) stays "settled"; otherwise the lot is held.
 */
export function resolveLotHeldForWinnerStatus(
  alreadyClaimed: boolean,
): "settled" | typeof HELD_FOR_WINNER {
  return alreadyClaimed ? "settled" : HELD_FOR_WINNER
}

/**
 * Decides the status LotUnwound should write. unwindStuckLot emits
 * LotReturnDeferred (setting "unwound_return_pending") before LotUnwound in
 * the same call when the lot's return to the seller also fails, both land
 * in the same tx, and Ponder processes them in log order, so LotUnwound's
 * own handler must not blindly overwrite what LotReturnDeferred just set.
 * Re-reading the row's current status and keeping "unwound_return_pending"
 * once it's there makes the outcome correct regardless of processing order.
 */
export function resolveLotUnwoundStatus(
  currentStatus: string,
): "unwound" | "unwound_return_pending" {
  return currentStatus === "unwound_return_pending" ? "unwound_return_pending" : "unwound"
}
