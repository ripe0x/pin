export function CatalogSummary({
  contracts,
  tokens,
  ranges,
}: {
  contracts: number
  tokens: number
  ranges: number
}) {
  const total = contracts + tokens + ranges
  if (total === 0) return null
  return (
    <div className="text-[11px] font-mono text-gray-500">
      <strong className="font-medium text-fg">{total}</strong>{" "}
      {total === 1 ? "entry" : "entries"} declared
    </div>
  )
}
