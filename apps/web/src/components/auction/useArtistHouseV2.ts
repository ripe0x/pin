"use client"

import { useReadContract } from "wagmi"
import { sovereignAuctionHouseV2FactoryAbi } from "@pin/abi"
import {
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"

const FACTORY = getAddressOrNull(
  SOVEREIGN_AUCTION_HOUSE_V2_FACTORY,
  MAINNET_CHAIN_ID,
)
const ZERO = "0x0000000000000000000000000000000000000000"

/**
 * Look up the V2 sovereign auction house for an artist. Returns null house
 * when none is deployed, and null factory when the V2 factory isn't live
 * yet (every V2 feature folds off on that null).
 *
 * `predictedAddress` is the deterministic clone address the factory will
 * deploy for this artist (Clones.cloneDeterministic salted by owner), so
 * approvals and listing calls can target the house inside the same
 * atomic bundle that deploys it.
 *
 * Same SSR caveat as useArtistHouse: callers must gate behind a mounted
 * check because useReadContract throws outside WagmiProvider.
 */
export function useArtistHouseV2(artistAddress: string | undefined) {
  const enabled = !!FACTORY && !!artistAddress

  const { data, isLoading, refetch } = useReadContract({
    address: FACTORY ?? undefined,
    abi: sovereignAuctionHouseV2FactoryAbi,
    functionName: "houseOf",
    args: artistAddress ? [artistAddress as `0x${string}`] : undefined,
    query: { enabled },
  })

  const { data: predicted } = useReadContract({
    address: FACTORY ?? undefined,
    abi: sovereignAuctionHouseV2FactoryAbi,
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
