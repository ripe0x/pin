"use client"

import { useReadContract } from "wagmi"
import { sovereignAuctionHouseFactoryAbi } from "@pin/abi"
import {
  SOVEREIGN_AUCTION_HOUSE_FACTORY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"

const FACTORY = getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_FACTORY, MAINNET_CHAIN_ID)
const ZERO = "0x0000000000000000000000000000000000000000"

/**
 * Look up the sovereign auction house address for an artist. Returns null when no
 * house has been deployed for that artist or the factory isn't live yet.
 *
 * IMPORTANT: callers must gate this hook behind a mounted check because
 * useReadContract calls useConfig internally, which throws if it runs during
 * SSR before WagmiProvider is in scope. The hook itself can't defer that —
 * it runs unconditionally. See ArtistHeader for the gating pattern.
 */
export function useArtistHouse(artistAddress: string | undefined) {
  const enabled = !!FACTORY && !!artistAddress

  const { data, isLoading, refetch } = useReadContract({
    address: FACTORY ?? undefined,
    abi: sovereignAuctionHouseFactoryAbi,
    functionName: "houseOf",
    args: artistAddress ? [artistAddress as `0x${string}`] : undefined,
    query: { enabled },
  })

  const address =
    data && data !== ZERO ? (data as `0x${string}`) : null

  return {
    factoryAddress: FACTORY,
    houseAddress: address,
    isLoading: enabled && isLoading,
    refetch,
  }
}
