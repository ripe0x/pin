import type { CheckStatus } from "@/lib/dependency-check"

const LABELS: Record<CheckStatus, string> = {
  Detected: "Detected",
  NeedsReview: "Needs review",
  NotFound: "Not found",
  UnableToCheck: "Unable to check",
  NotCheckedYet: "Not checked yet",
}

const STYLES: Record<CheckStatus, string> = {
  Detected: "border-emerald-300 text-emerald-700 bg-emerald-50",
  NeedsReview: "border-amber-300 text-amber-700 bg-amber-50",
  NotFound: "border-gray-200 text-gray-500 bg-white",
  UnableToCheck: "border-gray-200 text-gray-400 bg-gray-50",
  NotCheckedYet: "border-gray-200 text-gray-400 bg-gray-50",
}

export function StatusBadge({ status }: { status: CheckStatus }) {
  return (
    <span
      className={`inline-flex items-center text-[11px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border ${STYLES[status]}`}
    >
      {LABELS[status]}
    </span>
  )
}
