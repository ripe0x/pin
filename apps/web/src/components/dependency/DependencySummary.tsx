import type { DependencyReport } from "@/lib/dependency-check"

export function DependencySummary({
  summary,
  indexerHealthy,
}: {
  summary: DependencyReport["summary"]
  indexerHealthy: boolean
}) {
  const cells: Array<{ label: string; value: number; tone?: string }> = [
    { label: "Checks run", value: summary.run },
    { label: "Detected", value: summary.detected, tone: "text-emerald-700" },
    { label: "Needs review", value: summary.review, tone: "text-amber-700" },
    { label: "Not found", value: summary.notFound },
    { label: "Not checked yet", value: summary.notChecked },
  ]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
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
      {!indexerHealthy && (
        <p className="text-xs text-amber-700">
          One or more checks could not complete. Affected cards are marked
          Unable to check.
        </p>
      )}
    </div>
  )
}
