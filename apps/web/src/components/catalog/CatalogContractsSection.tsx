import type { Address } from "viem"
import { ContractLabel } from "./CatalogRowLabels"

export function CatalogContractsSection({
  contracts,
}: {
  contracts: Address[]
}) {
  if (contracts.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No contracts declared yet.
      </p>
    )
  }
  return (
    <ul className="space-y-2">
      {contracts.map((c) => (
        <li
          key={c}
          className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-3"
        >
          <ContractLabel address={c} />
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
