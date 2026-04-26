/**
 * Sequential cancel runner for Foundation listings.
 *
 * Loops the selected items, sending one transaction at a time and awaiting
 * each receipt before moving on. A failure on one item is recorded on that
 * row but does not stop the loop — partial completion is fine. The user can
 * cancel the remaining items via `stop()`.
 */
"use client"

import { useCallback, useRef, useState } from "react"
import { useConfig } from "wagmi"
import { writeContract, waitForTransactionReceipt } from "@wagmi/core"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import type { SellerListing } from "./seller-listings"

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]

export type ItemStatus =
  | { state: "idle" }
  | { state: "confirming" }
  | { state: "mining"; txHash: `0x${string}` }
  | { state: "done"; txHash: `0x${string}` }
  | { state: "failed"; error: string }

export type RunStatus = "idle" | "running" | "done"

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes("User rejected") || msg.includes("User denied")) {
    return "Transaction rejected"
  }
  if (msg.includes("insufficient funds")) return "Insufficient ETH balance"
  return msg.split("\n")[0]
}

export function useSequentialCancel() {
  const config = useConfig()
  const [status, setStatus] = useState<RunStatus>("idle")
  const [perItemStatus, setPerItemStatus] = useState<Map<string, ItemStatus>>(
    new Map(),
  )
  const stopRef = useRef(false)

  const updateItem = useCallback((id: string, next: ItemStatus) => {
    setPerItemStatus((prev) => {
      const m = new Map(prev)
      m.set(id, next)
      return m
    })
  }, [])

  const stop = useCallback(() => {
    stopRef.current = true
  }, [])

  const reset = useCallback(() => {
    stopRef.current = false
    setStatus("idle")
    setPerItemStatus(new Map())
  }, [])

  const run = useCallback(
    async (items: SellerListing[]) => {
      if (status === "running" || items.length === 0) return
      stopRef.current = false
      setStatus("running")
      setPerItemStatus(new Map(items.map((i) => [i.id, { state: "idle" }])))

      for (const item of items) {
        if (stopRef.current) break

        updateItem(item.id, { state: "confirming" })

        try {
          const txHash =
            item.kind === "auction"
              ? await writeContract(config, {
                  address: MARKET_ADDRESS,
                  abi: nftMarketAbi,
                  functionName: "cancelReserveAuction",
                  args: [item.auctionId],
                })
              : await writeContract(config, {
                  address: MARKET_ADDRESS,
                  abi: nftMarketAbi,
                  functionName: "cancelBuyPrice",
                  args: [item.nftContract, BigInt(item.tokenId)],
                })

          updateItem(item.id, { state: "mining", txHash })

          await waitForTransactionReceipt(config, { hash: txHash })

          updateItem(item.id, { state: "done", txHash })
        } catch (err) {
          updateItem(item.id, { state: "failed", error: friendlyError(err) })
          // Continue loop — other items may still succeed.
        }
      }

      setStatus("done")
    },
    [config, status, updateItem],
  )

  return { run, stop, reset, status, perItemStatus }
}
