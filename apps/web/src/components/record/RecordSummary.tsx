export function RecordSummary({
  contracts,
  tokens,
  ranges,
  hasSuccessor,
}: {
  contracts: number
  tokens: number
  ranges: number
  hasSuccessor: boolean
}) {
  const cells = [
    { label: "Contracts", value: contracts },
    { label: "Tokens", value: tokens },
    { label: "Ranges", value: ranges },
    { label: "Successor", value: hasSuccessor ? "Set" : "—" },
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cells.map((c) => (
        <div key={c.label} className="border border-gray-200 rounded-md px-4 py-3">
          <div className="text-2xl font-semibold">{c.value}</div>
          <div className="text-xs text-gray-500 mt-0.5">{c.label}</div>
        </div>
      ))}
    </div>
  )
}
