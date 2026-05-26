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
    { label: contracts === 1 ? "contract" : "contracts", value: contracts },
    { label: tokens === 1 ? "token" : "tokens", value: tokens },
    { label: ranges === 1 ? "range" : "ranges", value: ranges },
  ]
  return (
    <div className="flex items-center gap-3 text-[11px] font-mono text-gray-500">
      {cells.map((c, i) => (
        <span key={c.label} className="flex items-center gap-3">
          {i > 0 && (
            <span aria-hidden className="text-gray-300">
              ·
            </span>
          )}
          <span>
            <strong className="font-medium text-fg">{c.value}</strong>{" "}
            {c.label}
          </span>
        </span>
      ))}
    </div>
  )
}
