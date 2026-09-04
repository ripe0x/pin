/**
 * Generic ordered call runner. Takes prepared calls (`{id, to, data}`)
 * and executes them either as EIP-5792 bundles or as sequential
 * transactions, picked automatically from the connected wallet's
 * `wallet_sendCalls` capability. Extracted from useSequentialCancel so
 * multi-step flows (the V1 to V2 house upgrade: deploy, cancel, approve,
 * relist) share one runner with the cancel flows.
 *
 *   - "batched"    → ⌈N/10⌉ signatures. Smart wallets only (Coinbase
 *                    Smart Wallet, Safe, EIP-7702 setups). Call order is
 *                    preserved within and across chunks.
 *   - "sequential" → N signatures, one per call, each mined before the
 *                    next starts. Works for any wallet.
 *
 * Per-call knobs:
 *   - `write`: wagmi write-shaped call used in sequential mode so the
 *     wallet can decode and display the function instead of raw data.
 *   - `skipPreflight`: set on calls whose success depends on earlier
 *     calls in the same run (deploy-then-list, cancel-then-relist). The
 *     eth_estimateGas preflight runs against current chain state, so it
 *     would falsely condemn them.
 */
"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useAccount, useCapabilities, useConfig } from "wagmi"
import {
  estimateGas,
  sendCalls,
  sendTransaction,
  waitForCallsStatus,
  waitForTransactionReceipt,
  writeContract,
} from "@wagmi/core"
import type { Abi, Address } from "viem"

export type CallMode = "loading" | "batched" | "sequential"

/**
 * Calls per EIP-5792 bundle. MetaMask's wallet_sendCalls implementation
 * rejects bundles with more than 10 calls (documented hard cap); other
 * 5792 wallets vary but 10 is a safe lower bound that needs no per-wallet
 * detection.
 */
export const BATCH_CHUNK_SIZE = 10

export type PreparedCall = {
  id: string
  to: Address
  data: `0x${string}`
  value?: bigint
  write?: {
    address: Address
    abi: Abi
    functionName: string
    args: readonly unknown[]
    value?: bigint
  }
  skipPreflight?: boolean
  skipReason?: string
}

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
 * failing to deliver it)? A revert means the call is verifiably doomed —
 * drop it; a transport error (timeout, 429, 5xx) means we know nothing —
 * keep the call in the run and let the wallet/chain be the judge. The
 * revert reason lives in viem's `.cause` chain, so walk it.
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

const DEFAULT_SKIP_REASON = "Already resolved on-chain — nothing to send"

export function useBatchedCalls() {
  const config = useConfig()
  const { address, isConnected, chainId, connector } = useAccount()
  const { data: capabilities, isLoading: capabilitiesLoading } = useCapabilities({
    query: { enabled: isConnected },
  })

  // Pick the execution mode from the wallet's reported capabilities. We're
  // permissive about the response shape — EIP-5792 went through revisions and
  // some wallets report `atomicBatch.supported`, others `atomic.status`.
  const mode: CallMode = useMemo(() => {
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
   * Pre-flight a call via `eth_estimateGas` with `from` = the connected
   * account, just before it's signed. On-chain state dies out from under
   * the page (a bid lands, a sale settles, data is cached), and in an
   * ATOMIC bundle one stale call reverts the entire chunk. Estimation
   * reverts for a stale call, so we can drop it before any signature.
   * Calls marked `skipPreflight` (dependent on earlier calls in the run)
   * always report "live".
   */
  const preflight = useCallback(
    async (item: PreparedCall): Promise<"live" | "stale" | "unknown"> => {
      if (item.skipPreflight) return "live"
      try {
        await estimateGas(config, {
          account: address,
          to: item.to,
          data: item.data,
          value: item.value,
        })
        return "live"
      } catch (err) {
        // Only a verifiable EVM revert condemns the row; transport noise
        // must not silently drop a live call.
        return isRevertError(err) ? "stale" : "unknown"
      }
    },
    [config, address],
  )

  const runSequential = useCallback(
    async (items: PreparedCall[], record: (id: string, next: ItemStatus) => void) => {
      const updateItem = record
      for (const item of items) {
        if (stopRef.current) break
        updateItem(item.id, { state: "confirming" })

        // Stale rows get skipped before the wallet popup instead of
        // making the user sign a transaction that's doomed to revert.
        if ((await preflight(item)) === "stale") {
          updateItem(item.id, {
            state: "skipped",
            reason: item.skipReason ?? DEFAULT_SKIP_REASON,
          })
          continue
        }

        try {
          const txHash = item.write
            ? await writeContract(config, {
                address: item.write.address,
                abi: item.write.abi,
                functionName: item.write.functionName,
                args: item.write.args,
                value: item.write.value,
              })
            : await sendTransaction(config, {
                to: item.to,
                data: item.data,
                value: item.value,
              })

          updateItem(item.id, { state: "mining", txHash })
          await waitForTransactionReceipt(config, { hash: txHash })
          updateItem(item.id, { state: "done", txHash })
        } catch (err) {
          updateItem(item.id, { state: "failed", error: friendlyError(err) })
          if (item.skipPreflight) {
            // Later calls depend on this one (deploy-then-list,
            // cancel-then-relist). Continuing would sign transactions
            // that are doomed to revert.
            break
          }
          // Independent call — continue; partial completion is fine.
        }
      }
    },
    [config, preflight],
  )

  const runBatched = useCallback(
    async (items: PreparedCall[], record: (id: string, next: ItemStatus) => void) => {
      const updateItem = record
      // For N > BATCH_CHUNK_SIZE we chunk into multiple signed bundles —
      // the user signs ⌈N/10⌉ times instead of the wallet rejecting the
      // oversized bundle outright. Order is preserved across chunks.
      const chunks: PreparedCall[][] = []
      for (let i = 0; i < items.length; i += BATCH_CHUNK_SIZE) {
        chunks.push(items.slice(i, i + BATCH_CHUNK_SIZE))
      }

      // Initial state: everything in "confirming" so the user knows the whole
      // run is queued. We'll narrow per-chunk as we go.
      for (const item of items) updateItem(item.id, { state: "confirming" })

      for (const rawChunk of chunks) {
        if (stopRef.current) break

        // Pre-flight the chunk at sign time. These bundles are atomic on
        // smart wallets: one stale call reverts the whole chunk, so every
        // independent call we submit must be known-good moments before
        // the signature.
        const checks = await Promise.all(rawChunk.map(preflight))
        const chunk: PreparedCall[] = []
        rawChunk.forEach((item, i) => {
          if (checks[i] === "stale") {
            updateItem(item.id, {
              state: "skipped",
              reason: item.skipReason ?? DEFAULT_SKIP_REASON,
            })
          } else {
            chunk.push(item)
          }
        })
        // Whole chunk already dead — nothing to sign.
        if (chunk.length === 0) continue

        let bundleId: string
        try {
          const calls = chunk.map((c) => ({
            to: c.to,
            data: c.data,
            value: c.value,
          }))
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
          // under one signature flow. Five minutes covers slow mainnet gas
          // conditions with comfortable headroom.
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
    [config, preflight],
  )

  /**
   * Executes the calls and resolves to the final per-item outcomes, so
   * callers composing dependent phases (relist only what cancelled) can
   * branch on results without racing React state.
   */
  const run = useCallback(
    async (items: PreparedCall[]): Promise<Map<string, ItemStatus>> => {
      const outcomes = new Map<string, ItemStatus>(
        items.map((i) => [i.id, { state: "idle" } as ItemStatus]),
      )
      if (status === "running" || items.length === 0) return outcomes
      stopRef.current = false
      setStatus("running")
      setPerItemStatus(new Map(outcomes))

      const record = (id: string, next: ItemStatus) => {
        outcomes.set(id, next)
        updateItem(id, next)
      }

      if (mode === "batched") {
        await runBatched(items, record)
      } else {
        await runSequential(items, record)
      }

      setStatus("done")
      return outcomes
    },
    [mode, runBatched, runSequential, status, updateItem],
  )

  return { run, stop, reset, status, perItemStatus, mode, walletLabel }
}
