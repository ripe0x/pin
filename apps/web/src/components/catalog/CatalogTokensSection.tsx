import { TokenLabel } from "./CatalogRowLabels"

export function CatalogTokensSection({
  tokens,
}: {
  tokens: Array<{ contractAddress: string; tokenId: string }>
}) {
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
        </li>
      ))}
    </ul>
  )
}
