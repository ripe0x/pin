"use client"

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { useAccount, useConfig } from "wagmi"
import {
  writeContract as writeContractAction,
  waitForTransactionReceipt,
} from "wagmi/actions"
import { encodeFunctionData, type Address } from "viem"
import { catalogAbi } from "@pin/abi"
import {
  ARTIST_RECORD_REGISTRY,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import { FORK_CHAIN_ID } from "@/lib/wagmi"
import type { CatalogOp } from "@/lib/import-sources/types"

/**
 * Batch-writer for the Catalog. Uses the imperative `writeContract`
 * wagmi action (same pattern as MigratePanel / SovereignBulkPanel) so
 * the call cleanly awaits a hash even under the dev mock connector —
 * the `useWriteContract` hook variant got stuck between renders when
 * we tried to chain it for sequential chunks.
 *
 * Each chunk is encoded as N `addToken` / `addTokenRange` inner calls
 * packed into a single `multicall(bytes[])` transaction. Chunking is
 * the caller's responsibility; this hook just runs the loop and
 * surfaces progress.
 */

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const WRITE_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : MAINNET_CHAIN_ID

function encodeOp(op: CatalogOp): `0x${string}` {
  if (op.kind === "addToken") {
    return encodeFunctionData({
      abi: catalogAbi,
      functionName: "addToken",
      args: [op.contract, op.tokenId],
    })
  }
  if (op.kind === "addTokenRange") {
    return encodeFunctionData({
      abi: catalogAbi,
      functionName: "addTokenRange",
      args: [op.contract, op.start, op.end],
    })
  }
  return encodeFunctionData({
    abi: catalogAbi,
    functionName: "addContract",
    args: [op.contract],
  })
}

export type BatchPhase =
  | { kind: "idle" }
  | { kind: "signing"; index: number; total: number }
  | { kind: "mining"; index: number; total: number; hash: `0x${string}` }
  | { kind: "chunk-done"; index: number; total: number; hash: `0x${string}` }
  | { kind: "done"; total: number; hashes: `0x${string}`[] }
  | { kind: "error"; index: number; total: number; message: string; hash?: `0x${string}` }

export function useCatalogMulticall() {
  const router = useRouter()
  const { address: connected } = useAccount()
  const config = useConfig()
  const registry = ARTIST_RECORD_REGISTRY[MAINNET_CHAIN_ID]

  const [phase, setPhase] = useState<BatchPhase>({ kind: "idle" })
  const [hashes, setHashes] = useState<`0x${string}`[]>([])

  /**
   * Run a batch of chunks end-to-end: sign each one in sequence, await
   * its receipt, then move to the next. Returns the array of tx hashes
   * on full success (caller can link them); on a per-chunk failure the
   * loop halts and `phase` becomes `{ kind: "error" }`.
   */
  const runBatch = useCallback(
    async (chunks: CatalogOp[][]): Promise<void> => {
      if (!registry) return
      if (chunks.length === 0) return

      const total = chunks.length
      const accumulated: `0x${string}`[] = []
      setHashes([])

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const data = chunk.map(encodeOp)

        setPhase({ kind: "signing", index: i, total })

        let hash: `0x${string}`
        try {
          hash = await writeContractAction(config, {
            chainId: WRITE_CHAIN_ID,
            address: registry,
            abi: catalogAbi,
            functionName: "multicall",
            args: [data],
          })
        } catch (e) {
          const message =
            e instanceof Error
              ? (
                  (e as Error & { shortMessage?: string }).shortMessage ??
                  e.message
                ).slice(0, 300)
              : String(e).slice(0, 300)
          setPhase({ kind: "error", index: i, total, message })
          return
        }

        accumulated.push(hash)
        setHashes([...accumulated])
        setPhase({ kind: "mining", index: i, total, hash })

        try {
          const receipt = await waitForTransactionReceipt(config, { hash })
          if (receipt.status !== "success") {
            setPhase({
              kind: "error",
              index: i,
              total,
              message: "Transaction reverted on chain.",
              hash,
            })
            return
          }
        } catch (e) {
          const message = e instanceof Error ? e.message.slice(0, 300) : String(e)
          setPhase({ kind: "error", index: i, total, message, hash })
          return
        }

        setPhase({ kind: "chunk-done", index: i, total, hash })
      }

      setPhase({ kind: "done", total, hashes: accumulated })

      // Bust the catalog cache so the artist's record page reflects the
      // new entries on next read (Ponder's 300s polling means the live
      // indexer can lag for a few minutes — the cache bust at least
      // re-renders the read route, which falls back to a fresh on-chain
      // multicall when the indexer hasn't caught up).
      if (connected) {
        try {
          await fetch(`/api/catalog/${connected.toLowerCase()}/revalidate`, {
            method: "POST",
          })
        } catch {
          // best-effort; the page still works without it
        }
      }
      router.refresh()
    },
    [config, connected, registry, router],
  )

  const reset = useCallback(() => {
    setPhase({ kind: "idle" })
    setHashes([])
  }, [])

  return {
    registry: registry as Address | undefined,
    runBatch,
    reset,
    phase,
    hashes,
    isRunning:
      phase.kind === "signing" ||
      phase.kind === "mining" ||
      phase.kind === "chunk-done",
  }
}
