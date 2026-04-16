"use client"

import { PROVIDER_INFO, type ProviderType } from "@/lib/pinning"

export function ProviderSelect({
  selected,
  onSelect,
}: {
  selected: ProviderType
  onSelect: (provider: ProviderType) => void
}) {
  const providers = Object.values(PROVIDER_INFO)

  return (
    <div className="space-y-3">
      {providers.map((p) => (
        <button
          key={p.id}
          onClick={() => onSelect(p.id)}
          className={`w-full text-left border rounded-lg p-4 transition-colors ${
            selected === p.id
              ? "border-black bg-gray-50"
              : "border-gray-200 hover:border-gray-400"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{p.name}</span>
            <span className="text-xs text-gray-400">{p.freeTier}</span>
          </div>
          <p className="text-sm text-gray-500 mt-1">{p.description}</p>
        </button>
      ))}
    </div>
  )
}
