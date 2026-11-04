"use client"

import Link from "next/link"
import {
  ERC1155_LISTINGS_NEED_V2_1_NOTICE,
  ERC1155_LISTINGS_PAUSED_NOTICE,
  V1_LISTINGS_PAUSED_NOTICE,
  type ListingBlockReason,
} from "@/lib/auction-policy"
import { sovereignV2_1Factory } from "@/lib/sovereign-v2-1"

// Only V2 houses reach "erc1155-paused" (V2.1 houses allow 1155 lots). Once
// the V2.1 factory is live, say why instead of "not available yet".
const V2_1_LIVE = sovereignV2_1Factory() !== null

/**
 * Shown in place of a listing form when lib/auction-policy.ts blocks the
 * listing: a V1 house (points the owner at the V1-to-V2 upgrade flow) or
 * an ERC-1155 lot on a V2 house (V2.1 houses take them).
 */
export function ListingBlockedNotice({
  reason,
  ownerAddress,
}: {
  reason: ListingBlockReason
  /** House owner, for the upgrade link on a V1 house. */
  ownerAddress?: string
}) {
  if (reason === "erc1155-paused") {
    return (
      <p className="text-sm text-gray-600">
        {V2_1_LIVE ? ERC1155_LISTINGS_NEED_V2_1_NOTICE : ERC1155_LISTINGS_PAUSED_NOTICE}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600">{V1_LISTINGS_PAUSED_NOTICE}</p>
      {ownerAddress && (
        <Link
          href={`/studio/${ownerAddress}/migrate`}
          className="inline-block text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors"
        >
          Upgrade your house →
        </Link>
      )}
    </div>
  )
}
