"use client"

import type { Address } from "viem"
import { useIsRecordOwner } from "./useIsRecordOwner"
import { AddContractForm } from "./AddContractForm"
import { RemoveRowButton } from "./RemoveRowButton"

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

/**
 * Contracts section in edit mode. The page swaps from the read-only
 * `RecordContractsSection` to this one once the connected wallet
 * matches the URL artist, so server-rendered HTML stays untouched
 * for visitors.
 */
export function RecordContractsEditable({
  artist,
  contracts,
}: {
  artist: Address
  contracts: Address[]
}) {
  const isOwner = useIsRecordOwner(artist)
  if (!isOwner) {
    return contracts.length === 0 ? (
      <p className="text-sm text-gray-500">No contracts declared yet.</p>
    ) : (
      <ul className="space-y-2">
        {contracts.map((c) => (
          <li
            key={c}
            className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-3"
          >
            <div className="font-mono text-sm">{shortAddr(c)}</div>
            <a
              href={`https://evm.now/address/${c}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors shrink-0"
            >
              evm.now ↗
            </a>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="space-y-3">
      <AddContractForm />
      {contracts.length === 0 ? (
        <p className="text-sm text-gray-500">
          No contracts declared yet. Add the first one above.
        </p>
      ) : (
        <ul className="space-y-2">
          {contracts.map((c) => (
            <li
              key={c}
              className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-3"
            >
              <div className="font-mono text-sm">{shortAddr(c)}</div>
              <RemoveRowButton fn="removeContract" args={[c]} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
