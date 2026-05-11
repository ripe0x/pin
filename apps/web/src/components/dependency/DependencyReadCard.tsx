import type { DependencyRead } from "@/lib/dependency-check"

const TONE: Record<DependencyRead["label"], string> = {
  Lower: "border-emerald-200 bg-emerald-50",
  Moderate: "border-amber-200 bg-amber-50",
  Higher: "border-amber-200 bg-amber-50",
  Unknown: "border-gray-200 bg-gray-50",
}

const LABEL_TEXT: Record<DependencyRead["label"], string> = {
  Lower: "Lower dependency",
  Moderate: "Moderate dependency",
  Higher: "Higher dependency",
  Unknown: "Unknown",
}

export function DependencyReadCard({ read }: { read: DependencyRead }) {
  return (
    <div className={`border rounded-md p-5 space-y-2 ${TONE[read.label]}`}>
      <div className="text-xs uppercase tracking-wide text-gray-600">
        Dependency read
      </div>
      <div className="text-xl font-semibold">{LABEL_TEXT[read.label]}</div>
      <p className="text-sm text-gray-700">{read.summary}</p>
    </div>
  )
}
