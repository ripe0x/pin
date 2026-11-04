"use client"

import { useArtistHouseV2 } from "./useArtistHouseV2"
import { useArtistHouseV2_1 } from "./useArtistHouseV2_1"

/**
 * The V2-family house the V1 upgrade flow (HouseUpgradePanel,
 * UpgradeHouseBanner) moves listings to. Same shape as useArtistHouseV2,
 * and the V2.1 factory/house ABIs match V2's for every call the flow makes
 * (createAuctionHouse, predictHouseAddress, bulkCreateAuctions,
 * cancelAuction), so callers need no other change.
 *
 *   - an existing V2.1 house, else
 *   - an existing V2 house (an owner who upgraded before V2.1 shipped
 *     finishes into the house they already have), else
 *   - a new V2.1 house once the V2.1 factory is live, else
 *   - a new V2 house (today, while V2.1 is undeployed: unchanged).
 */
export function useUpgradeTargetHouse(artistAddress: string | undefined) {
  const v2 = useArtistHouseV2(artistAddress)
  const v2_1 = useArtistHouseV2_1(artistAddress)
  if (v2_1.houseAddress) return { ...v2_1, isV2_1: true as boolean }
  if (v2.houseAddress) return { ...v2, isV2_1: false as boolean }
  if (v2_1.factoryAddress) {
    // Until both lookups settle, report no factory (callers fold away) so
    // a V2 house that is still loading is never skipped in favor of
    // deploying a second, V2.1 house.
    if (v2.isLoading || v2_1.isLoading) {
      return { ...v2_1, factoryAddress: null, predictedAddress: null, isLoading: true, isV2_1: true as boolean }
    }
    return { ...v2_1, isV2_1: true as boolean }
  }
  return { ...v2, isV2_1: false as boolean }
}
