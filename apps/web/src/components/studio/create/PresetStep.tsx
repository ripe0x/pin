"use client"

import { PRESETS, PRESET_LABEL, PRESET_DESCRIPTION, type Preset } from "@/lib/create-collection"

export function PresetStep({
  onSelect,
}: {
  onSelect: (preset: Preset) => void
}) {
  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">Create a collection</h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          Deploy your own onchain contract. You own it outright: no protocol fee, no
          upgrade path, no one else&rsquo;s keys.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onSelect(preset)}
            className="text-left rounded-lg border border-gray-200 bg-surface p-4 space-y-2 hover:border-gray-400 transition-colors"
          >
            <p className="text-sm font-medium">{PRESET_LABEL[preset]}</p>
            <p className="text-xs text-gray-500 leading-relaxed">
              {PRESET_DESCRIPTION[preset]}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}
