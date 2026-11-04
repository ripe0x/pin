"use client"

/**
 * One studio write for the primitive v2 panels: simulate the call from the
 * connected account on PREFERRED_CHAIN first (a revert surfaces inline,
 * decoded, before any wallet prompt), then sign the simulated request with
 * chainId pinned, then wait for the receipt and call `onConfirmed` (the
 * panel re-reads its live state).
 */

import { useEffect } from "react"
import type { Abi, Address } from "viem"
import { useAccount, useConfig, useWaitForTransactionReceipt, useWriteContract } from "wagmi"
import { simulateContract } from "wagmi/actions"
import { PREFERRED_CHAIN } from "@/components/tx/tx-ui"
import { usePreflight } from "@/lib/use-preflight"

export type V2Call = {
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
}

export function useV2Write(onConfirmed: () => void) {
  const config = useConfig()
  const { address: account } = useAccount()
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data, chainId: PREFERRED_CHAIN.id })
  const preflight = usePreflight()

  useEffect(() => {
    if (receipt.isSuccess) onConfirmed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess])

  const run = (call: V2Call) => {
    if (!account) return
    write.reset()
    void preflight.run(async () => {
      const { request } = await simulateContract(config, {
        account,
        chainId: PREFERRED_CHAIN.id,
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      write.writeContract({ ...(request as any), chainId: PREFERRED_CHAIN.id })
    })
  }

  const busy = preflight.checking || write.isPending || receipt.isLoading
  const label = preflight.checking
    ? "Checking…"
    : write.isPending
      ? "Confirm in wallet…"
      : receipt.isLoading
        ? "Saving…"
        : null
  const error = preflight.error ?? write.error ?? receipt.error ?? null
  return { run, busy, label, error, done: receipt.isSuccess }
}
