export function CatalogSummary({
  contracts,
  tokens,
  ranges,
}: {
  contracts: number
  tokens: number
  ranges: number
}) {
  const cells = [
    { label: "Contracts", value: contracts },
    { label: "Tokens", value: tokens },
    { label: "Ranges", value: ranges },
  ]
  return (
    <div className="grid grid-cols-3 gap-3">
      {cells.map((c) => (
        <div key={c.label} className="border border-gray-200 rounded-md px-4 py-3">
          <div className="text-2xl font-semibold">{c.value}</div>
          <div className="text-xs text-gray-500 mt-0.5">{c.label}</div>
        </div>
      ))}
    </div>
  )
}
