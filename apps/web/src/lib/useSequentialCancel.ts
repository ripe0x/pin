/**
 * Cancel runner for Foundation listings.
 *
 * Two execution modes, picked automatically from the connected wallet's
 * EIP-5792 (`wallet_sendCalls`) capability:
 *
 *   - "batched"    → one signature, one bundle. Smart wallets only
 *                    (Coinbase Smart Wallet, Safe, EIP-7702 setups).
 *   - "sequential" → N signatures, one per cancel, with per-row progress.
 *                    Works for any wallet (MetaMask, Rabby, Frame, …).
 *
 * The hook exposes `mode` and `walletLabel` so the UI can explain to the
 * user why they're getting one signature vs. N.
 */
"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useAccount, useCapabilities, useConfig } from "wagmi"
import {
  sendCalls,
  waitForCallsStatus,
  waitForTransactionReceipt,
  writeContract,
} from "@wagmi/core"
import { encodeFunctionData } from "viem"
import { nftMarketAbi } from "@pin/abi"
import { NFT_MARKET, MAINNET_CHAIN_ID } from "@pin/addresses"
import type { SellerListing } from "./seller-listings"

const MARKET_ADDRESS = NFT_MARKET[MAINNET_CHAIN_ID]

export type CancelMode = "loading" | "batched" | "sequential"

export type ItemStatus =
  | { state: "idle" }
  | { state: "confirming" }
  | { state: "mining"; txHash?: `0x${string}` }
  | { state: "done"; txHash?: `0x${string}` }
  | { state: "failed"; error: string }

export type RunStatus = "idle" | "running" | "done"

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (
    msg.includes("User rejected") ||
    msg.includes("User denied") ||
    msg.includes("UserRejected")
  ) {
    return "Transaction rejected"
  }
  if (msg.includes("insufficient funds")) return "Insufficient ETH balance"
  return msg.split("\n")[0]
}

function encodeCancelCall(item: SellerListing): { to: `0x${string}`; data: `0x${string}` } {
  if (item.kind === "auction") {
    return {
      to: MARKET_ADDRESS,
      data: encodeFunctionData({
        abi: nftMarketAbi,
        functionName: "cancelReserveAuction",
        args: [item.auctionId],
      }),
    }
  }
  return {
    to: MARKET_ADDRESS,
    data: encodeFunctionData({
      abi: nftMarketAbi,
      functionName: "cancelBuyPrice",
      args: [item.nftContract, BigInt(item.tokenId)],
    }),
  }
}

export function useSequentialCancel() {
  const config = useConfig()
  const { isConnected, chainId, connector } = useAccount()
  const { data: capabilities, isLoading: capabilitiesLoading } = useCapabilities({
    query: { enabled: isConnected },
  })

  // Pick the execution mode from the wallet's reported capabilities. We're
  // permissive about the response shape — EIP-5792 went through revisions and
  // some wallets report `atomicBatch.supported`, others `atomic.status`.
  const mode: CancelMode = useMemo(() => {
    if (!isConnected) return "sequential"
    if (capabilitiesLoading) return "loading"
    if (!capabilities || !chainId) return "sequential"
    const c = (capabilities as Record<number, unknown>)[chainId]
    if (!c) return "sequential"
    const caps = c as {
      atomicBatch?: { supported?: boolean }
      atomic?: { status?: string }
    }
    if (caps.atomicBatch?.supported === true) return "batched"
    if (caps.atomic?.status && caps.atomic.status !== "unsupported") return "batched"
    return "sequential"
  }, [isConnected, capabilitiesLoading, capabilities, chainId])

  const walletLabel = connector?.name ?? null

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
    // Only meaningful in sequential mode — once a bundle is submitted there's
    // no client-side cancel.
    stopRef.current = true
  }, [])

  const reset = useCallback(() => {
    stopRef.current = false
    setStatus("idle")
    setPerItemStatus(new Map())
  }, [])

  const runSequential = useCallback(
    async (items: SellerListing[]) => {
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
          // Continue — partial completion is fine.
        }
      }
    },
    [config, updateItem],
  )

  const runBatched = useCallback(
    async (items: SellerListing[]) => {
      // All items show "Confirm…" while the user signs the single bundle.
      for (const item of items) updateItem(item.id, { state: "confirming" })

      let bundleId: string
      try {
        const calls = items.map(encodeCancelCall)
        const result = await sendCalls(config, { calls })
        bundleId = result.id
      } catch (err) {
        const reason = friendlyError(err)
        for (const item of items) updateItem(item.id, { state: "failed", error: reason })
        return
      }

      // Bundle submitted; wallet is mining. We don't have per-call tx hashes
      // until waitForCallsStatus resolves.
      for (const item of items) updateItem(item.id, { state: "mining" })

      try {
        const result = await waitForCallsStatus(config, { id: bundleId })
        const receipts = result.receipts ?? []
        items.forEach((item, i) => {
          const receipt = receipts[i]
          if (receipt && receipt.status === "success") {
            updateItem(item.id, {
              state: "done",
              txHash: receipt.transactionHash as `0x${string}` | undefined,
            })
          } else if (receipt) {
            updateItem(item.id, {
              state: "failed",
              error: "Reverted on-chain",
            })
          } else {
            // No receipt for this index — surface the bundle's terminal status.
            const ok = result.status === "success"
            updateItem(
              item.id,
              ok
                ? { state: "done" }
                : { state: "failed", error: "Bundle did not include a receipt for this call" },
            )
          }
        })
      } catch (err) {
        const reason = friendlyError(err)
        for (const item of items) updateItem(item.id, { state: "failed", error: reason })
      }
    },
    [config, updateItem],
  )

  const run = useCallback(
    async (items: SellerListing[]) => {
      if (status === "running" || items.length === 0) return
      stopRef.current = false
      setStatus("running")
      setPerItemStatus(new Map(items.map((i) => [i.id, { state: "idle" }])))

      if (mode === "batched") {
        await runBatched(items)
      } else {
        await runSequential(items)
      }

      setStatus("done")
    },
    [mode, runBatched, runSequential, status],
  )

  return { run, stop, reset, status, perItemStatus, mode, walletLabel }
}
