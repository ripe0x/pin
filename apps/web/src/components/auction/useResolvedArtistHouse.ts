"use client"

import { useCallback } from "react"
import type { Address } from "viem"
import { useArtistHouse } from "./useArtistHouse"
import { useArtistHouseV2 } from "./useArtistHouseV2"
import { useArtistHouseV2_1 } from "./useArtistHouseV2_1"

export type ResolvedHouse = {
  /** The house app features should operate on: the V2.1 house when one
   *  exists, else the V2 house, else the V1 house, else null. */
  houseAddress: Address | null
  /** ABI/UI generation of `houseAddress`: 2 for V2 and V2.1 houses (same
   *  ABI), 1 for V1; null when no house exists. */
  version: 1 | 2 | null
  /** True when `houseAddress` is a V2.1 house (held-for-winner
   *  settlement, ERC-1155 listings allowed). */
  isV2_1: boolean
  v1House: Address | null
  v2House: Address | null
  v2_1House: Address | null
  /** The factory a new deploy would use (V2.1 when live, else V2, else
   *  V1); null when no generation's factory is configured. */
  factoryAddress: Address | null
  isLoading: boolean
  refetch: () => void
}

/**
 * Version-aware artist house resolution. An artist can hold one house
 * per factory generation; reads and writes should target the newest.
 * Callers that need generation-specific behavior (ABI choice, 1155
 * support) branch on `version` and `isV2_1`. Same SSR caveat as
 * useArtistHouse: gate behind a mounted check.
 *
 * While the V2.1 factory is undeployed its hook makes no reads and
 * returns null, so this resolves exactly as before (V2, then V1).
 */
export function useResolvedArtistHouse(artistAddress: string | undefined): ResolvedHouse {
  const v1 = useArtistHouse(artistAddress)
  const v2 = useArtistHouseV2(artistAddress)
  const v2_1 = useArtistHouseV2_1(artistAddress)

  const refetch = useCallback(() => {
    void v1.refetch()
    void v2.refetch()
    void v2_1.refetch()
  }, [v1, v2, v2_1])

  const houseAddress = v2_1.houseAddress ?? v2.houseAddress ?? v1.houseAddress
  const version: 1 | 2 | null =
    v2_1.houseAddress || v2.houseAddress ? 2 : v1.houseAddress ? 1 : null

  return {
    houseAddress,
    version,
    isV2_1: !!v2_1.houseAddress,
    v1House: v1.houseAddress,
    v2House: v2.houseAddress,
    v2_1House: v2_1.houseAddress,
    factoryAddress: v2_1.factoryAddress ?? v2.factoryAddress ?? v1.factoryAddress,
    isLoading: v1.isLoading || v2.isLoading || v2_1.isLoading,
    refetch,
  }
}
