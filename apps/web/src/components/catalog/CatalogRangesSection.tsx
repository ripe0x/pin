import { ContractLabel } from "./CatalogRowLabels"

export function CatalogRangesSection({
  ranges,
}: {
  ranges: Array<{
    contractAddress: string
    startTokenId: string
    endTokenId: string
  }>
}) {
  if (ranges.length === 0) {
    return (
      <p className="text-sm text-gray-500">No token ranges declared yet.</p>
    )
  }
  return (
    <ul className="space-y-2">
      {ranges.map((r) => (
        <li
          key={`${r.contractAddress}:${r.startTokenId}:${r.endTokenId}`}
          className="border border-gray-200 rounded-md px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap"
        >
          <div className="min-w-0 space-y-0.5">
            <ContractLabel address={r.contractAddress} />
            <div className="text-[11px] font-mono text-gray-500">
              Tokens {r.startTokenId}
              {r.startTokenId === r.endTokenId
                ? ""
                : `–${r.endTokenId}`}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
