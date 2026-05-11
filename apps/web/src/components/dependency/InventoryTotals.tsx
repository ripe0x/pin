import type { InventoryTotals as Totals } from "@/lib/dependency-check"

export function InventoryTotals({ totals }: { totals: Totals }) {
  const cells: Array<{ label: string; value: number; tone?: string }> = [
    { label: "Tokens", value: totals.totalTokens },
    { label: "Contracts", value: totals.totalContracts },
    {
      label: "Artist-owned",
      value: totals.artistOwnedContracts,
      tone: "text-emerald-700",
    },
    { label: "Shared", value: totals.sharedContracts },
    { label: "Platform", value: totals.platformContracts },
    { label: "Unknown", value: totals.unknownContracts },
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {cells.map((c) => (
        <div
          key={c.label}
          className="border border-gray-200 rounded-md px-4 py-3"
        >
          <div className={`text-2xl font-semibold ${c.tone ?? "text-fg"}`}>
            {c.value}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">{c.label}</div>
        </div>
      ))}
    </div>
  )
}
