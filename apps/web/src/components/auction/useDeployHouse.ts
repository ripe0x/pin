"use client"

import { useEffect } from "react"
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import {
  sovereignAuctionHouseFactoryAbi,
  sovereignAuctionHouseV2FactoryAbi,
} from "@pin/abi"
import {
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"
import { useArtistHouse } from "./useArtistHouse"
import { useResolvedArtistHouse } from "./useResolvedArtistHouse"

const V2_FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  MAINNET_CHAIN_ID,
)

/**
 * Drives the `createAuctionHouse()` call and exposes the lifecycle state
 * for callers that want to render their own UI (banners, inline migration
 * flows, etc.). New houses deploy from the V2 factory whenever its
 * address is live; the V1 factory remains only as the fallback while V2
 * is unreleased. DeployHouseCTA renders the canonical UI; MigratePanel
 * uses this hook to fold the deploy step into a longer sequence.
 */
export function useDeployHouse(artistAddress: string | undefined) {
  const v1 = useArtistHouse(artistAddress)
  const resolved = useResolvedArtistHouse(artistAddress)

  const factoryAddress = V2_FACTORY ?? v1.factoryAddress
  const deployVersion: 1 | 2 = V2_FACTORY ? 2 : 1

  const { writeContract, data: txHash, isPending, error, reset } =
    useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  useEffect(() => {
    if (!isSuccess) return
    resolved.refetch()
    // Bust the server-side sov-house cache so the artist page's active-
    // auction gate (getSovereignHouseOf) doesn't keep reporting no house
    // for up to its 1h TTL. Best-effort, never blocks the UI.
    if (artistAddress) {
      void fetch("/api/sovereign-house/revalidate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: artistAddress }),
      }).catch(() => {})
    }
  }, [isSuccess, resolved, artistAddress])

  function deploy() {
    if (!factoryAddress) return
    writeContract({
      address: factoryAddress,
      abi:
        deployVersion === 2
          ? sovereignAuctionHouseV2FactoryAbi
          : sovereignAuctionHouseFactoryAbi,
      functionName: "createAuctionHouse",
      args: [],
    })
  }

  return {
    factoryAddress,
    deployVersion,
    houseAddress: resolved.houseAddress,
    houseVersion: resolved.version,
    refetch: resolved.refetch,
    deploy,
    txHash,
    isPending,
    isMining,
    isSuccess,
    error,
    reset,
  }
}
