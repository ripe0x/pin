"use client"

import {
  useAccount,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import type { Address } from "viem"
import {
  muriProtocolAbi,
  ierc721CreatorCoreAbi,
} from "@pin/abi"
import {
  MAINNET_CHAIN_ID,
  MURI_PROTOCOL,
  MURI_MANIFOLD_EXTENSION,
} from "@pin/addresses"
import { FORK_CHAIN_ID } from "@/lib/wagmi"

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const WRITE_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : MAINNET_CHAIN_ID

const MURI = MURI_PROTOCOL[MAINNET_CHAIN_ID]
const EXT = MURI_MANIFOLD_EXTENSION[MAINNET_CHAIN_ID]

export type MuriSetupStep = "extension" | "register"

/**
 * Reads the one-time-setup state for minting MURI-native tokens on a
 * Manifold Creator Core contract, and exposes the two setup writes.
 *
 * Setup is: (1) register the MURI extension on the Manifold contract
 * (`registerExtension`), then (2) register the contract with MURI
 * (`registerContract`). Both are admin-gated; we read `isAdmin` to gate
 * the UI. All reads run only when the artist opens this flow on their own
 * contract — never on a public page.
 */
export function useMuriSetup(contract: Address | undefined) {
  const { address: connected } = useAccount()

  const reads = useReadContracts({
    allowFailure: true,
    contracts:
      contract && connected
        ? [
            {
              chainId: WRITE_CHAIN_ID,
              address: contract,
              abi: ierc721CreatorCoreAbi,
              functionName: "getExtensions",
            },
            {
              chainId: WRITE_CHAIN_ID,
              address: contract,
              abi: ierc721CreatorCoreAbi,
              functionName: "isAdmin",
              args: [connected],
            },
            {
              chainId: WRITE_CHAIN_ID,
              address: MURI,
              abi: muriProtocolAbi,
              functionName: "isContractOperator",
              args: [contract, EXT],
            },
          ]
        : [],
    query: { enabled: Boolean(contract && connected) },
  })

  const extensions = (reads.data?.[0]?.result as Address[] | undefined) ?? []
  const isAdmin = (reads.data?.[1]?.result as boolean | undefined) ?? false
  const isContractRegistered =
    (reads.data?.[2]?.result as boolean | undefined) ?? false

  const isExtensionRegistered = extensions.some(
    (e) => e.toLowerCase() === EXT.toLowerCase(),
  )

  const { writeContract, data: txHash, isPending, error, reset } =
    useWriteContract()
  const {
    data: receipt,
    isLoading: isMining,
    isSuccess: receiptFetched,
  } = useWaitForTransactionReceipt({ hash: txHash })

  const isSuccess = receiptFetched && receipt?.status === "success"
  const isReverted = receiptFetched && receipt?.status === "reverted"

  function call(step: MuriSetupStep) {
    if (!contract) return
    if (step === "extension") {
      writeContract({
        chainId: WRITE_CHAIN_ID,
        address: contract,
        abi: ierc721CreatorCoreAbi,
        functionName: "registerExtension",
        args: [EXT, ""],
      })
    } else {
      writeContract({
        chainId: WRITE_CHAIN_ID,
        address: MURI,
        abi: muriProtocolAbi,
        functionName: "registerContract",
        args: [contract, EXT],
      })
    }
  }

  return {
    // setup state
    isAdmin,
    isExtensionRegistered,
    isContractRegistered,
    isReady: isExtensionRegistered && isContractRegistered,
    readsLoading: reads.isLoading,
    refetch: reads.refetch,
    // write lifecycle
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
