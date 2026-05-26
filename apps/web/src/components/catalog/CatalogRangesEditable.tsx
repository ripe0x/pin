"use client"

import type { Address } from "viem"
import { useIsCatalogOwner } from "./useIsCatalogOwner"
import { RemoveRowButton } from "./RemoveRowButton"
import { ContractLabel, ContractThumbnail } from "./CatalogRowLabels"

export function CatalogRangesEditable({
  artist,
  ranges,
  thumbnails,
}: {
  artist: Address
  ranges: Array<{
    contractAddress: string
    startTokenId: string
    endTokenId: string
  }>
  thumbnails?: Record<string, string>
}) {
  const isOwner = useIsCatalogOwner(artist)
  if (ranges.length === 0) {
    return <p className="text-sm text-gray-500">No token ranges declared yet.</p>
  }
  return (
    <ul className="space-y-2">
      {ranges.map((r) => (
        <li
          key={`${r.contractAddress}:${r.startTokenId}:${r.endTokenId}`}
          className="border border-gray-200 rounded-md px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap"
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <ContractThumbnail
              src={thumbnails?.[r.contractAddress.toLowerCase()]}
            />
            <div className="min-w-0 space-y-0.5 flex-1">
              <ContractLabel address={r.contractAddress} />
              <div className="text-[11px] font-mono text-gray-500">
                Tokens {r.startTokenId}
                {r.startTokenId === r.endTokenId ? "" : `–${r.endTokenId}`}
              </div>
            </div>
          </div>
          {isOwner && (
            <RemoveRowButton
              fn="removeTokenRange"
              args={[
                r.contractAddress as `0x${string}`,
                BigInt(r.startTokenId),
                BigInt(r.endTokenId),
              ]}
            />
          )}
        </li>
      ))}
    </ul>
  )
}
