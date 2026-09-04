import Link from "next/link"
import type { PreservationFact, PreservationGrade } from "@/lib/preservation"

/**
 * The Preservation card: a plain-language fact list answering "what does this
 * work need to render, and what is locked". Facts and the summary come from
 * the pure grade model (lib/preservation.ts); this component only presents
 * them, so it fires no reads. Tones drive the dot color, never a letter grade.
 */

const DOT: Record<PreservationFact["tone"], string> = {
  good: "bg-status-live",
  neutral: "bg-gray-400 dark:bg-gray-500",
  caution: "bg-status-upcoming",
}

export function PreservationCard({ grade }: { grade: PreservationGrade }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 border-b border-gray-100">
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          Preservation
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          {grade.summary}
        </span>
      </div>
      <ul className="px-4 py-3 space-y-2">
        {grade.facts.map((f, i) => (
          <li key={i} className="flex items-start gap-2.5 text-xs text-fg-muted leading-relaxed">
            <span
              className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[f.tone]}`}
              aria-hidden="true"
            />
            <span>{f.label}</span>
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3">
        <Link
          href="/guides/preservation"
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
        >
          What preservation means
        </Link>
      </div>
    </div>
  )
}
