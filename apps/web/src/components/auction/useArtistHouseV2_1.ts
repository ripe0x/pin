"use client"

import { useReadContract } from "wagmi"
import { sovereignAuctionHouseV2_1FactoryAbi } from "@pin/abi"
import { sovereignV2_1Factory } from "@/lib/sovereign-v2-1"

const FACTORY = sovereignV2_1Factory()
const ZERO = "0x0000000000000000000000000000000000000000"

/**
 * Look up the V2.1 sovereign auction house for an artist. Same shape as
 * useArtistHouseV2: null house when none is deployed, null factory while
 * the V2.1 factory is not deployed (no reads are made then, and every
 * V2.1 feature folds off on that null).
 *
 * Same SSR caveat as useArtistHouse: callers must gate behind a mounted
 * check because useReadContract throws outside WagmiProvider.
 */
export function useArtistHouseV2_1(artistAddress: string | undefined) {
  const enabled = !!FACTORY && !!artistAddress

  const { data, isLoading, refetch } = useReadContract({
    address: FACTORY ?? undefined,
    abi: sovereignAuctionHouseV2_1FactoryAbi,
    functionName: "houseOf",
    args: artistAddress ? [artistAddress as `0x${string}`] : undefined,
    query: { enabled },
  })

  const { data: predicted } = useReadContract({
    address: FACTORY ?? undefined,
    abi: sovereignAuctionHouseV2_1FactoryAbi,
    functionName: "predictHouseAddress",
    args: artistAddress ? [artistAddress as `0x${string}`] : undefined,
    query: { enabled },
  })

  const address = data && data !== ZERO ? (data as `0x${string}`) : null

  return {
    factoryAddress: FACTORY,
    houseAddress: address,
    predictedAddress: (predicted as `0x${string}` | undefined) ?? null,
    isLoading: enabled && isLoading,
    refetch,
  }
}
