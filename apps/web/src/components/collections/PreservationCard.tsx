import type { PreservationFact } from "@/lib/preservation"

/**
 * The compact "Preservation" card (issue #265): what can still change and
 * where the art lives, as plain facts from lib/preservation.ts. Purely
 * presentational; the page passes facts it built from reads it already
 * made. A filled dot marks a fact that can no longer change, a hollow dot
 * one the owner can still change.
 */
export function PreservationCard({ facts }: { facts: PreservationFact[] }) {
  if (facts.length === 0) return null
  return (
    <section className="rounded-lg border border-gray-200 bg-surface">
      <h2 className="border-b border-gray-100 px-4 py-2.5 text-[10px] font-mono font-medium uppercase tracking-wider text-gray-500">
        Preservation
      </h2>
      <dl className="space-y-2 px-4 py-3 text-[11px] font-mono">
        {facts.map((f) => (
          <div key={f.label} className="flex items-baseline justify-between gap-4">
            <dt className="flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wider text-gray-400">
              <span
                aria-hidden="true"
                className={
                  f.tone === "fixed"
                    ? "inline-block h-1.5 w-1.5 rounded-full bg-fg"
                    : f.tone === "open"
                      ? "inline-block h-1.5 w-1.5 rounded-full border border-gray-400"
                      : "inline-block h-1.5 w-1.5 rounded-full bg-gray-300"
                }
              />
              {f.label}
            </dt>
            <dd className="text-right text-fg-muted">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
