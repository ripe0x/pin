"use client"

import { useCallback } from "react"
import type { Address } from "viem"
import { useArtistHouse } from "./useArtistHouse"
import { useArtistHouseV2 } from "./useArtistHouseV2"

export type ResolvedHouse = {
  /** The house app features should operate on: the V2 house when one
   *  exists, else the V1 house, else null. */
  houseAddress: Address | null
  /** Generation of `houseAddress`; null when no house exists. */
  version: 1 | 2 | null
  v1House: Address | null
  v2House: Address | null
  /** The factory a new deploy would use (V2 when live, else V1); null
   *  when neither generation's factory is configured. */
  factoryAddress: Address | null
  isLoading: boolean
  refetch: () => void
}

/**
 * Version-aware artist house resolution. An artist can hold one house
 * per factory generation; reads and writes should target the newest.
 * Callers that need generation-specific behavior (ABI choice, 1155
 * support) branch on `version`. Same SSR caveat as useArtistHouse:
 * gate behind a mounted check.
 */
export function useResolvedArtistHouse(artistAddress: string | undefined): ResolvedHouse {
  const v1 = useArtistHouse(artistAddress)
  const v2 = useArtistHouseV2(artistAddress)

  const refetch = useCallback(() => {
    void v1.refetch()
    void v2.refetch()
  }, [v1, v2])

  const houseAddress = v2.houseAddress ?? v1.houseAddress
  const version: 1 | 2 | null = v2.houseAddress ? 2 : v1.houseAddress ? 1 : null

  return {
    houseAddress,
    version,
    v1House: v1.houseAddress,
    v2House: v2.houseAddress,
    factoryAddress: v2.factoryAddress ?? v1.factoryAddress,
    isLoading: v1.isLoading || v2.isLoading,
    refetch,
  }
}
