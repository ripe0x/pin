import { ContractLabel } from "./RecordRowLabels"

export function RecordRangesSection({
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
          className="border border-gray-200 rounded-md p-4 flex items-center justify-between gap-3 flex-wrap"
        >
          <div className="min-w-0 space-y-1">
            <ContractLabel address={r.contractAddress} />
            <div className="text-xs text-gray-500">
              Tokens {r.startTokenId}
              {r.startTokenId === r.endTokenId
                ? ""
                : ` – ${r.endTokenId}`}
            </div>
          </div>
          <a
            href={`https://evm.now/address/${r.contractAddress}`}
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
