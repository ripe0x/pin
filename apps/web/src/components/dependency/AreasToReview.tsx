import type { AreaEntry } from "@/lib/dependency-check"
import { StatusBadge } from "./StatusBadge"

export function AreasToReview({ areas }: { areas: AreaEntry[] }) {
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {areas.map((a) => (
        <li
          key={a.id}
          className={`border rounded-md p-4 space-y-2 ${
            a.canCheckNow
              ? "border-gray-200"
              : "border-dashed border-gray-200"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <h3
              className={`font-medium ${
                a.canCheckNow ? "" : "text-gray-700"
              }`}
            >
              {a.title}
            </h3>
            <StatusBadge status={a.status} />
          </div>
          <p
            className={`text-sm ${
              a.canCheckNow ? "text-gray-600" : "text-gray-500"
            }`}
          >
            {a.summary}
          </p>
          {a.whatWouldHelp && (
            <p className="text-xs text-gray-400 italic">
              {a.whatWouldHelp}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}
