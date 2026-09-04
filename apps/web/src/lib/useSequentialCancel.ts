/**
 * Cross-platform cancel runner. Dispatches per-listing cancel calls via
 * `buildCancelCall(listing)`, so the same hook handles Foundation auctions,
 * Foundation buy-nows, SuperRare V2 auctions, and any future platform that
 * lands an entry in the registry.
 *
 * Thin wrapper over useBatchedCalls, which owns mode detection (EIP-5792
 * batched vs sequential), chunking, pre-flight, and per-item status. This
 * hook only maps SellerListing rows to prepared calls.
 */
"use client"

import { useCallback } from "react"
import type { SellerListing } from "./seller-listings"
import {
  buildCancelCall,
  encodeCancelCallToData,
} from "@/lib/platforms/cancel-calls"
import {
  useBatchedCalls,
  BATCH_CHUNK_SIZE,
  type CallMode,
  type ItemStatus,
  type RunStatus,
  type PreparedCall,
} from "./useBatchedCalls"

export type CancelMode = CallMode
export { BATCH_CHUNK_SIZE }
export type { ItemStatus, RunStatus }

const SKIP_REASON = "Already inactive on-chain — no cancel needed"

export function useSequentialCancel() {
  const { run: runCalls, stop, reset, status, perItemStatus, mode, walletLabel } =
    useBatchedCalls()

  const run = useCallback(
    async (items: SellerListing[]) => {
      const calls: PreparedCall[] = items.map((item) => {
        const encoded = encodeCancelCallToData(item)
        return {
          id: item.id,
          to: encoded.to,
          data: encoded.data,
          value: encoded.value,
          // Sequential mode signs via writeContract so the wallet decodes
          // and displays the cancel function instead of raw calldata.
          write: buildCancelCall(item),
          skipReason: SKIP_REASON,
        }
      })
      await runCalls(calls)
    },
    [runCalls],
  )

  return { run, stop, reset, status, perItemStatus, mode, walletLabel }
}
