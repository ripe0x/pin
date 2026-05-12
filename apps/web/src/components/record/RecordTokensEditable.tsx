"use client"

import type { Address } from "viem"
import { useIsRecordOwner } from "./useIsRecordOwner"
import { AddTokenForm } from "./AddTokenForm"
import { RemoveRowButton } from "./RemoveRowButton"

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function RecordTokensEditable({
  artist,
  tokens,
}: {
  artist: Address
  tokens: Array<{ contractAddress: string; tokenId: string }>
}) {
  const isOwner = useIsRecordOwner(artist)

  const list = (
    <ul className="space-y-2">
      {tokens.map((t) => (
        <li
          key={`${t.contractAddress}:${t.tokenId}`}
          className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-3 flex-wrap"
        >
          <div className="min-w-0 space-y-0.5">
            <div className="font-mono text-sm">
              {shortAddr(t.contractAddress)}
            </div>
            <div className="text-xs text-gray-500">Token #{t.tokenId}</div>
          </div>
          {isOwner ? (
            <RemoveRowButton
              fn="removeToken"
              args={[
                t.contractAddress as `0x${string}`,
                BigInt(t.tokenId),
              ]}
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

  if (!isOwner) {
    return tokens.length === 0 ? (
      <p className="text-sm text-gray-500">No tokens declared yet.</p>
    ) : (
      list
    )
  }

  return (
    <div className="space-y-3">
      <AddTokenForm />
      {tokens.length === 0 ? (
        <p className="text-sm text-gray-500">
          No tokens declared yet. Add the first one above.
        </p>
      ) : (
        list
      )}
    </div>
  )
}
