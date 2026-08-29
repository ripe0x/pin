import type { ProfileSummary } from "@/lib/profile-queries"

export function ProfileCoverage({ summary }: { summary: ProfileSummary }) {
  if (summary.ownershipCoverage.length === 0) return null
  return (
    <details className="border border-gray-200 px-3 py-2 text-xs text-gray-600">
      <summary className="cursor-pointer font-medium text-fg">Indexed ownership coverage</summary>
      <div className="mt-3 space-y-2">
        {summary.ownershipCoverage.map((row) => (
          <div key={`${row.source}:${row.status}`} className="flex flex-col justify-between gap-1 sm:flex-row">
            <span className="font-mono">{row.source} · {row.itemCount} {row.itemCount === 1 ? "holding" : "holdings"}</span>
            <span className="font-mono text-[10px] text-gray-500">
              {row.status} · {row.finalized ? "finalized" : "head-following"}
              {row.observedAt ? ` · ${new Date(row.observedAt).toLocaleString()}` : ""}
            </span>
          </div>
        ))}
      </div>
    </details>
  )
}

export function ProfileCuration() {
  return (
    <section id="curation" className="scroll-mt-20 space-y-2 border-t border-gray-200 pt-8">
      <h2 className="text-lg font-semibold">Curation</h2>
      <p className="max-w-3xl text-xs leading-relaxed text-gray-500">
        PND does not infer curation from ownership, favorites, or an artist&apos;s Catalog declarations. A curator role will appear only when PND supports portable authored exhibitions or lists with canonical token references, ordering, context, a signature, and a preservation snapshot.
      </p>
    </section>
  )
}
