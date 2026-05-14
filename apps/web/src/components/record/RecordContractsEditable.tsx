"use client"

import type { Address } from "viem"
import { useIsRecordOwner } from "./useIsRecordOwner"
import { RemoveRowButton } from "./RemoveRowButton"
import { ContractLabel } from "./RecordRowLabels"

/**
 * Contracts section. Renders the list of declared contracts. When the
 * connected wallet matches the URL artist, each row gains a Remove
 * button. The Add form lives at the top of the page (AddEntryForm) —
 * not duplicated per section.
 */
export function RecordContractsEditable({
  artist,
  contracts,
}: {
  artist: Address
  contracts: Address[]
}) {
  const isOwner = useIsRecordOwner(artist)
  if (contracts.length === 0) {
    return <p className="text-sm text-gray-500">No contracts declared yet.</p>
  }
  return (
    <ul className="space-y-2">
      {contracts.map((c) => (
        <li
          key={c}
          className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-3"
        >
          <ContractLabel address={c} />
          {isOwner ? (
            <RemoveRowButton fn="removeContract" args={[c]} />
          ) : (
            <a
              href={`https://evm.now/address/${c}`}
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
