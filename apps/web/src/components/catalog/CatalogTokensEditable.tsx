"use client"

import type { Address } from "viem"
import { useIsStudioOwner } from "@/components/studio/useIsStudioOwner"
import { RemoveRowButton } from "./RemoveRowButton"
import { TokenLabel } from "./CatalogRowLabels"

export function CatalogTokensEditable({
  artist,
  tokens,
}: {
  artist: Address
  tokens: Array<{ contractAddress: string; tokenId: string }>
}) {
  const isOwner = useIsStudioOwner(artist)
  if (tokens.length === 0) {
    return <p className="text-sm text-gray-500">No tokens declared yet.</p>
  }
  return (
    <ul className="space-y-2">
      {tokens.map((t) => (
        <li
          key={`${t.contractAddress}:${t.tokenId}`}
          className="border border-gray-200 rounded-md px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap"
        >
          <TokenLabel
            contractAddress={t.contractAddress}
            tokenId={t.tokenId}
          />
          {isOwner && (
            <RemoveRowButton
              fn="removeToken"
              args={[t.contractAddress as `0x${string}`, BigInt(t.tokenId)]}
            />
          )}
        </li>
      ))}
    </ul>
  )
}
