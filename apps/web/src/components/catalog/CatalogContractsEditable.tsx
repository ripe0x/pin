"use client"

import type { Address } from "viem"
import { useIsCatalogOwner } from "./useIsCatalogOwner"
import { RemoveRowButton } from "./RemoveRowButton"
import {
  ContractLabel,
  ContractThumbnail,
  ContractTotalSupplyBadge,
} from "./CatalogRowLabels"

/**
 * Contracts section. Renders the list of declared contracts. When the
 * connected wallet matches the URL artist, each row gains a Remove
 * button. The Add form lives at the top of the page (AddEntryForm) —
 * not duplicated per section.
 */
export function CatalogContractsEditable({
  artist,
  contracts,
  thumbnails,
}: {
  artist: Address
  contracts: Address[]
  thumbnails?: Record<string, string>
}) {
  const isOwner = useIsCatalogOwner(artist)
  if (contracts.length === 0) {
    return <p className="text-sm text-gray-500">No contracts declared yet.</p>
  }
  return (
    <ul className="space-y-2">
      {contracts.map((c) => (
        <li
          key={c}
          className="border border-gray-200 rounded-md px-3 py-2.5 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <ContractThumbnail src={thumbnails?.[c.toLowerCase()]} />
            <ContractLabel address={c} />
          </div>
          <ContractTotalSupplyBadge address={c} />
          {isOwner && <RemoveRowButton fn="removeContract" args={[c]} />}
        </li>
      ))}
    </ul>
  )
}
