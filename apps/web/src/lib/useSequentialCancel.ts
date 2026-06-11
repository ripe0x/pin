/**
 * Cross-platform cancel runner. Dispatches per-listing cancel calls via
 * `buildCancelCall(listing)`, so the same hook handles Foundation auctions,
 * Foundation buy-nows, SuperRare V2 auctions, and any future platform that
 * lands an entry in the registry.
 *
 * Two execution modes, picked automatically from the connected wallet's
 * EIP-5792 (`wallet_sendCalls`) capability:
 *
 *   - "batched"    → one signature, one bundle. Smart wallets only
 *                    (Coinbase Smart Wallet, Safe, EIP-7702 setups).
 *                    Cross-contract bundles are valid (FND + SR cancels
 *                    in one bundle just produce different `to` entries).
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
  estimateGas,
  sendCalls,
  waitForCallsStatus,
  waitForTransactionReceipt,
  writeContract,
} from "@wagmi/core"
import type { SellerListing } from "./seller-listings"
import {
  buildCancelCall,
  encodeCancelCallToData,
} from "@/lib/platforms/cancel-calls"

export type CancelMode = "loading" | "batched" | "sequential"

/**
 * Calls per EIP-5792 bundle. MetaMask's wallet_sendCalls implementation
 * rejects bundles with more than 10 calls (documented hard cap); other
 * 5792 wallets vary but 10 is a safe lower bound that needs no per-wallet
 * detection. Gas is nowhere near binding at this size: a cancel measures
 * ~110-135k gas, so a full chunk is ~1.3M — ~2% of a block and far below
 * typical bundler userOp caps (~10M).
 */
export const BATCH_CHUNK_SIZE = 10

export type ItemStatus =
  | { state: "idle" }
  | { state: "confirming" }
  | { state: "mining"; txHash?: `0x${string}` }
  | { state: "done"; txHash?: `0x${string}` }
  | { state: "failed"; error: string }
  | { state: "skipped"; reason: string }

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

/**
 * Match viem's WaitForCallsStatusTimeoutError. We don't import the class so
 * the bundler doesn't pull viem error types into this client module — the
 * message and `name` checks are the documented identification path.
 */
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "WaitForCallsStatusTimeoutError") return true
  return /Timed out while waiting for call bundle/i.test(err.message)
}

/**
 * Did this error come from the EVM rejecting the call (vs the transport
 * failing to deliver it)? The distinction decides the pre-flight outcome:
 * a revert means the listing is verifiably gone — drop it; a transport
 * error (timeout, 429, 5xx) means we know nothing — keep the call in the
 * run and let the wallet/chain be the judge. The revert reason lives in
 * viem's `.cause` chain, so walk it.
 */
function isRevertError(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; depth < 6 && cur instanceof Error; depth++) {
    const e = cur as Error & { shortMessage?: string; cause?: unknown }
    if (/revert/i.test(e.message) || /revert/i.test(e.shortMessage ?? "")) {
      return true
    }
    cur = e.cause
  }
  return false
}


export function useSequentialCancel() {
  const config = useConfig()
  const { address, isConnected, chainId, connector } = useAccount()
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

  /**
   * Pre-flight a cancel via `eth_estimateGas` with `from` = the connected
   * seller, just before it's signed. Listings die out from under the page
   * (a bid lands, a sale settles, the data is up to 1h cached), and in an
   * ATOMIC bundle one stale call reverts the entire chunk — which is how
   * "delisting too many at once fails" presents to users. Estimation
   * reverts for a stale listing, so we can drop it before any signature.
   *
   * Goes through the app transport (`/api/rpc` in prod: eth_estimateGas is
   * allowlisted, Alchemy→public fallbacks behind it). Called per chunk at
   * sign time — ≤10 estimates per signature — so it stays far inside the
   * proxy's 240/min per-IP budget and the result can't go stale during a
   * long multi-chunk run.
   */
  const preflight = useCallback(
    async (item: SellerListing): Promise<"live" | "stale" | "unknown"> => {
      try {
        const call = encodeCancelCallToData(item)
        await estimateGas(config, {
          account: address,
          to: call.to,
          data: call.data,
          value: call.value,
        })
        return "live"
      } catch (err) {
        // Only a verifiable EVM revert condemns the row; transport noise
        // must not silently drop a cancellable listing.
        return isRevertError(err) ? "stale" : "unknown"
      }
    },
    [config, address],
  )

  const SKIP_REASON = "Already inactive on-chain — no cancel needed"

  const runSequential = useCallback(
    async (items: SellerListing[]) => {
      for (const item of items) {
        if (stopRef.current) break
        updateItem(item.id, { state: "confirming" })

        // Stale rows get skipped before the wallet popup instead of
        // making the user sign a transaction that's doomed to revert.
        if ((await preflight(item)) === "stale") {
          updateItem(item.id, { state: "skipped", reason: SKIP_REASON })
          continue
        }

        try {
          const call = buildCancelCall(item)
          const txHash = await writeContract(config, {
            address: call.address,
            abi: call.abi,
            functionName: call.functionName,
            args: call.args,
            value: call.value,
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
    [config, preflight, updateItem],
  )

  const runBatched = useCallback(
    async (items: SellerListing[]) => {
      // For N > BATCH_CHUNK_SIZE we chunk into multiple signed bundles —
      // the user signs ⌈N/10⌉ times instead of the wallet rejecting the
      // oversized bundle outright.
      const chunks: SellerListing[][] = []
      for (let i = 0; i < items.length; i += BATCH_CHUNK_SIZE) {
        chunks.push(items.slice(i, i + BATCH_CHUNK_SIZE))
      }

      // Initial state: everything in "confirming" so the user knows the whole
      // run is queued. We'll narrow per-chunk as we go.
      for (const item of items) updateItem(item.id, { state: "confirming" })

      for (const rawChunk of chunks) {
        if (stopRef.current) break

        // Pre-flight the chunk at sign time. These bundles are atomic on
        // smart wallets: one stale call reverts all ten, so every call we
        // submit must be known-good moments before the signature.
        const checks = await Promise.all(rawChunk.map(preflight))
        const chunk: SellerListing[] = []
        rawChunk.forEach((item, i) => {
          if (checks[i] === "stale") {
            updateItem(item.id, { state: "skipped", reason: SKIP_REASON })
          } else {
            chunk.push(item)
          }
        })
        // Whole chunk already dead — nothing to sign.
        if (chunk.length === 0) continue

        let bundleId: string
        try {
          const calls = chunk.map(encodeCancelCallToData)
          const result = await sendCalls(config, { calls })
          bundleId = result.id
        } catch (err) {
          const reason = friendlyError(err)
          for (const item of chunk) updateItem(item.id, { state: "failed", error: reason })
          // Partial completion is fine — earlier chunks may have succeeded.
          // Continue to surface user-rejection on subsequent chunks immediately
          // rather than auto-stopping.
          continue
        }

        for (const item of chunk) updateItem(item.id, { state: "mining" })

        try {
          // viem's default timeout is 60s, which isn't enough for wallets like
          // MetaMask that implement EIP-5792 by submitting N sequential txs
          // under one signature flow — 10 cancels at ~15s/block = ~150s before
          // the bundle reports "confirmed". Five minutes covers slow mainnet
          // gas conditions with comfortable headroom.
          const result = await waitForCallsStatus(config, {
            id: bundleId,
            timeout: 5 * 60 * 1000,
          })
          const receipts = result.receipts ?? []
          chunk.forEach((item, i) => {
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
          if (isTimeoutError(err)) {
            for (const item of chunk) {
              updateItem(item.id, {
                state: "failed",
                error: "Submitted — refresh to see status",
              })
            }
          } else {
            const reason = friendlyError(err)
            for (const item of chunk) updateItem(item.id, { state: "failed", error: reason })
          }
        }
      }
    },
    [config, preflight, updateItem],
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
