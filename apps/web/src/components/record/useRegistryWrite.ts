"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import {
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { artistRecordRegistryAbi } from "@pin/abi"
import {
  ARTIST_RECORD_REGISTRY,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import type { Address } from "viem"

/**
 * Thin wrapper around `useWriteContract` for the ArtistRecordRegistry.
 *
 * Returns a `call` function pre-bound to the registry address + ABI so
 * the consumer only specifies the function name and args. Lifecycle
 * state (pending sign / mining / confirmed / error) is exposed
 * verbatim from wagmi. On confirmation, calls `router.refresh()` so
 * the server-rendered record on /record/[address] re-reads the
 * registry and re-renders.
 *
 * Same pattern as `useDeployHouse` — local hook per write surface,
 * each form on the page owns its own instance so concurrent writes
 * don't clobber each other's state.
 */
export type RegistryFunctionName =
  | "addContract"
  | "addContractFor"
  | "removeContract"
  | "removeContractFor"
  | "addToken"
  | "addTokenFor"
  | "removeToken"
  | "removeTokenFor"
  | "addTokenRange"
  | "addTokenRangeFor"
  | "removeTokenRange"
  | "removeTokenRangeFor"
  | "setOperator"
  | "setSuccessor"

export function useRegistryWrite() {
  const router = useRouter()
  const registry = ARTIST_RECORD_REGISTRY[MAINNET_CHAIN_ID]

  const { writeContract, data: txHash, isPending, error, reset } =
    useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  // After a write confirms, refresh the server-rendered record so the
  // UI reflects the new state. We don't optimistic-update because the
  // registry is the source of truth and a re-read is cheap.
  useEffect(() => {
    if (isSuccess) router.refresh()
  }, [isSuccess, router])

  function call<Args extends readonly unknown[]>(
    functionName: RegistryFunctionName,
    args: Args,
  ) {
    if (!registry) return
    writeContract({
      address: registry,
      abi: artistRecordRegistryAbi,
      functionName,
      args: args as unknown as never,
    })
  }

  return {
    registry: registry as Address | undefined,
    call,
    txHash,
    isPending,
    isMining,
    isSuccess,
    error,
    reset,
    busy: isPending || isMining,
  }
}
