/**
 * Pure V2 auction status-transition helpers, split out of SovereignV2.ts so
 * they can be unit tested directly — SovereignV2.ts imports the
 * "ponder:registry"/"ponder:schema" virtual modules, which only resolve
 * inside a running Ponder build, not a standalone test runner.
 */

/**
 * Decides the status LotUnwound should write. unwindStuckLot emits
 * LotReturnDeferred (setting "unwound_return_pending") before LotUnwound in
 * the same call when the lot's return to the seller also fails — both land
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
