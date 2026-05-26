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
          className="border border-gray-200 rounded-md px-3 py-2.5 flex items-center justify-between gap-3"
        >
          <ContractLabel address={c} />
        </li>
      ))}
    </ul>
  )
}
