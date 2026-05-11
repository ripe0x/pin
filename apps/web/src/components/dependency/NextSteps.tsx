import type { NextStep } from "@/lib/dependency-check"

export function NextSteps({ steps }: { steps: NextStep[] }) {
  if (steps.length === 0) return null
  return (
    <ul className="space-y-3">
      {steps.map((s) => (
        <li
          key={s.id}
          className="border border-gray-200 rounded-md p-4 flex items-start justify-between gap-4 flex-wrap"
        >
          <div className="min-w-0 space-y-1">
            <div className="font-medium">{s.title}</div>
            <p className="text-sm text-gray-600">{s.reason}</p>
          </div>
          <a
            href={s.href}
            className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors shrink-0"
          >
            Open
          </a>
        </li>
      ))}
    </ul>
  )
}
