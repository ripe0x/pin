import type { DependencyCard as DependencyCardType } from "@/lib/dependency-check"
import { StatusBadge } from "./StatusBadge"

export function DependencyCard({ card }: { card: DependencyCardType }) {
  return (
    <div className="border border-dashed border-gray-200 rounded-md p-4 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-medium text-gray-700">{card.title}</h3>
        <StatusBadge status={card.status} />
      </div>
      <p className="text-sm text-gray-500">{card.reason}</p>
    </div>
  )
}
