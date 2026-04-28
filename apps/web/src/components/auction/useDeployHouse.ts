"use client"

import { useEffect } from "react"
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { sovereignAuctionHouseFactoryAbi } from "@pin/abi"
import { useArtistHouse } from "./useArtistHouse"

/**
 * Drives the `createAuctionHouse()` call on the factory and exposes the
 * lifecycle state for callers that want to render their own UI (banners,
 * inline migration flows, etc.). DeployHouseCTA renders the canonical UI;
 * MigratePanel uses this hook to fold the deploy step into a longer
 * sequence without rendering DeployHouseCTA's card.
 */
export function useDeployHouse(artistAddress: string | undefined) {
  const { factoryAddress, houseAddress, refetch } = useArtistHouse(artistAddress)

  const { writeContract, data: txHash, isPending, error, reset } =
    useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  useEffect(() => {
    if (isSuccess) refetch()
  }, [isSuccess, refetch])

  function deploy() {
    if (!factoryAddress) return
    writeContract({
      address: factoryAddress,
      abi: sovereignAuctionHouseFactoryAbi,
      functionName: "createAuctionHouse",
      args: [],
    })
  }

  return {
    factoryAddress,
    houseAddress,
    refetch,
    deploy,
    txHash,
    isPending,
    isMining,
    isSuccess,
    error,
    reset,
  }
}
