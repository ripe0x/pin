"use client"

import type { Address } from "viem"
import { useIsRecordOwner } from "./useIsRecordOwner"
import { RemoveRowButton } from "./RemoveRowButton"
import { TokenLabel } from "./RecordRowLabels"

export function RecordTokensEditable({
  artist,
  tokens,
}: {
  artist: Address
  tokens: Array<{ contractAddress: string; tokenId: string }>
}) {
  const isOwner = useIsRecordOwner(artist)
  if (tokens.length === 0) {
    return <p className="text-sm text-gray-500">No tokens declared yet.</p>
  }
  return (
    <ul className="space-y-2">
      {tokens.map((t) => (
        <li
          key={`${t.contractAddress}:${t.tokenId}`}
          className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-3 flex-wrap"
        >
          <TokenLabel
            contractAddress={t.contractAddress}
            tokenId={t.tokenId}
          />
          {isOwner ? (
            <RemoveRowButton
              fn="removeToken"
              args={[t.contractAddress as `0x${string}`, BigInt(t.tokenId)]}
            />
          ) : (
            <a
              href={`https://evm.now/address/${t.contractAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors shrink-0"
            >
              evm.now ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  )
}
