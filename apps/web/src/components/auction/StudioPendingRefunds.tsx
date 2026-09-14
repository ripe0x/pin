"use client"

import { useArtistHouse } from "./useArtistHouse"
import { useArtistHouseV2 } from "./useArtistHouseV2"
import { PendingRefundCard } from "./PendingRefundCard"

/**
 * Refund balances across both house generations. Outbid refunds can sit on
 * either an artist's V1 house or their V2 house, so the studio auctions tab
 * checks both rather than only the newest.
 */
export function StudioPendingRefunds({ artistAddress }: { artistAddress: string }) {
  const v1 = useArtistHouse(artistAddress)
  const v2 = useArtistHouseV2(artistAddress)

  return (
    <>
      {v2.houseAddress && (
        <PendingRefundCard houseAddress={v2.houseAddress} houseVersion={2} />
      )}
      {v1.houseAddress && (
        <PendingRefundCard houseAddress={v1.houseAddress} houseVersion={1} />
      )}
    </>
  )
}
