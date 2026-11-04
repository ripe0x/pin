"use client"

import { useEffect } from "react"
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import {
  sovereignAuctionHouseFactoryAbi,
  sovereignAuctionHouseV2FactoryAbi,
  sovereignAuctionHouseV2_1FactoryAbi,
} from "@pin/abi"
import {
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"
import { PREFERRED_CHAIN } from "@/components/tx/tx-ui"
import { sovereignV2_1Factory } from "@/lib/sovereign-v2-1"
import { useArtistHouse } from "./useArtistHouse"
import { useResolvedArtistHouse } from "./useResolvedArtistHouse"

const V2_FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  MAINNET_CHAIN_ID,
)
// Null until the V2.1 factory is deployed (or NEXT_PUBLIC_SOVEREIGN_V2_1_FACTORY
// is set for a fork), so today this hook deploys from V2 exactly as before.
const V2_1_FACTORY = sovereignV2_1Factory()

/**
 * Drives the `createAuctionHouse()` call and exposes the lifecycle state
 * for callers that want to render their own UI (banners, inline migration
 * flows, etc.). New houses deploy from the newest live factory: V2.1 when
 * its address is set, else V2, else V1. DeployHouseCTA renders the
 * canonical UI; MigratePanel uses this hook to fold the deploy step into a
 * longer sequence.
 */
export function useDeployHouse(artistAddress: string | undefined) {
  const v1 = useArtistHouse(artistAddress)
  const resolved = useResolvedArtistHouse(artistAddress)

  const factoryAddress = V2_1_FACTORY ?? V2_FACTORY ?? v1.factoryAddress
  // ABI/UI generation of the house a deploy creates: V2.1 houses are 2.
  const deployVersion: 1 | 2 = V2_1_FACTORY || V2_FACTORY ? 2 : 1
  const deploysV2_1 = !!V2_1_FACTORY

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
      chainId: PREFERRED_CHAIN.id,
      address: factoryAddress,
      abi: deploysV2_1
        ? sovereignAuctionHouseV2_1FactoryAbi
        : deployVersion === 2
          ? sovereignAuctionHouseV2FactoryAbi
          : sovereignAuctionHouseFactoryAbi,
      functionName: "createAuctionHouse",
      args: [],
    })
  }

  return {
    factoryAddress,
    deployVersion,
    deploysV2_1,
    houseAddress: resolved.houseAddress,
    houseVersion: resolved.version,
    houseIsV2_1: resolved.isV2_1,
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
