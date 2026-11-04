"use client"

import { useArtistHouse } from "./useArtistHouse"
import { useArtistHouseV2 } from "./useArtistHouseV2"
import { useArtistHouseV2_1 } from "./useArtistHouseV2_1"
import { PendingRefundCard } from "./PendingRefundCard"

/**
 * Refund balances across every house generation. Outbid refunds and
 * contract-wallet proceeds can sit on an artist's V1, V2 or V2.1 house, so
 * the studio auctions tab checks each one the artist has rather than only
 * the newest. V2.1 shares V2's ABI (houseVersion 2).
 */
export function StudioPendingRefunds({ artistAddress }: { artistAddress: string }) {
  const v1 = useArtistHouse(artistAddress)
  const v2 = useArtistHouseV2(artistAddress)
  const v2_1 = useArtistHouseV2_1(artistAddress)

  return (
    <>
      {v2_1.houseAddress && (
        <PendingRefundCard houseAddress={v2_1.houseAddress} houseVersion={2} />
      )}
      {v2.houseAddress && (
        <PendingRefundCard houseAddress={v2.houseAddress} houseVersion={2} />
      )}
      {v1.houseAddress && (
        <PendingRefundCard houseAddress={v1.houseAddress} houseVersion={1} />
      )}
    </>
  )
}
