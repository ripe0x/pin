"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { catalogAbi } from "@pin/abi"
import {
  ARTIST_RECORD_REGISTRY,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import { FORK_CHAIN_ID } from "@/lib/wagmi"
import type { Address } from "viem"

// When dev fork mode is active the wallet should be on the fork chain,
// not mainnet. Pinning the target chainId on writeContract makes wagmi
// auto-prompt a chain switch if the wallet drifts (otherwise MetaMask
// throws `-32002 Requested resource not available` and the user has to
// guess what's wrong). In prod this is mainnet.
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const WRITE_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : MAINNET_CHAIN_ID

/**
 * Thin wrapper around `useWriteContract` for the Catalog.
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
export type CatalogFunctionName =
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

export function useCatalogWrite() {
  const router = useRouter()
  const { address: connected } = useAccount()
  const registry = ARTIST_RECORD_REGISTRY[MAINNET_CHAIN_ID]

  const { writeContract, data: txHash, isPending, error, reset } =
    useWriteContract()
  const {
    data: receipt,
    isLoading: isMining,
    isSuccess: receiptFetched,
  } = useWaitForTransactionReceipt({ hash: txHash })

  // wagmi's `isSuccess` from `useWaitForTransactionReceipt` means
  // "receipt was fetched", not "tx didn't revert" — a reverted tx still
  // has a fetchable receipt with `status: "reverted"`. Split into two
  // signals so the UI can distinguish "confirmed" from "reverted on
  // chain" instead of showing a green banner for failures.
  const isSuccess = receiptFetched && receipt?.status === "success"
  const isReverted = receiptFetched && receipt?.status === "reverted"

  // After a write confirms, bust the catalog cache (both
  // `unstable_cache` and `pgCache` — the route on its own keeps serving
  // the stale empty payload for the 5-min TTL otherwise) and then
  // `router.refresh()` so the server component re-renders with the
  // fresh registry state. Self-writes only: the connected wallet IS
  // the artist whose record was mutated.
  useEffect(() => {
    if (!isSuccess || !connected) return
    void fetch(`/api/catalog/${connected.toLowerCase()}/revalidate`, {
      method: "POST",
    })
      .catch(() => {})
      .finally(() => router.refresh())
  }, [isSuccess, connected, router])

  function call<Args extends readonly unknown[]>(
    functionName: CatalogFunctionName,
    args: Args,
  ) {
    if (!registry) return
    if (FORK_MODE) {
      // eslint-disable-next-line no-console
      console.log("[useCatalogWrite] writeContract", {
        chainId: WRITE_CHAIN_ID,
        address: registry,
        functionName,
        args,
        connected,
      })
    }
    writeContract(
      {
        chainId: WRITE_CHAIN_ID,
        address: registry,
        abi: catalogAbi,
        functionName,
        args: args as unknown as never,
      },
      {
        onError: (err) => {
          if (!FORK_MODE) return
          // eslint-disable-next-line no-console
          console.error("[useCatalogWrite] writeContract failed", err, {
            cause: (err as { cause?: unknown }).cause,
            details: (err as { details?: unknown }).details,
            shortMessage: (err as { shortMessage?: unknown }).shortMessage,
            metaMessages: (err as { metaMessages?: unknown }).metaMessages,
          })
        },
      },
    )
  }

  return {
    registry: registry as Address | undefined,
    call,
    txHash,
    isPending,
    isMining,
    isSuccess,
    isReverted,
    error,
    reset,
    busy: isPending || isMining,
  }
}
