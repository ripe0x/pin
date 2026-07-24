"use client"

import { PRESETS, PRESET_LABEL, PRESET_DESCRIPTION, type Preset } from "@/lib/create-collection"

const GENERATIVE_UNAVAILABLE_REASON =
  "Generative collections now ship as bring-your-own renderers. The guided flow for this is being rebuilt — use Renderer native with your own renderer contract instead."

const EDITION_UNAVAILABLE_REASON =
  "Not available yet — PND hasn't turned on the default renderer."

export function PresetStep({
  onSelect,
  editionAvailable,
}: {
  onSelect: (preset: Preset) => void
  editionAvailable: boolean
}) {
  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">Create a collection</h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          Deploys an immutable contract: no protocol fee, no upgrade path, only your
          wallet has admin access.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        {PRESETS.map((preset) => {
          const reason =
            preset === "generative"
              ? GENERATIVE_UNAVAILABLE_REASON
              : preset === "edition" && !editionAvailable
                ? EDITION_UNAVAILABLE_REASON
                : null
          const disabled = reason !== null

          return (
            <button
              key={preset}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(preset)}
              className={`text-left rounded-lg border p-4 space-y-2 transition-colors ${
                disabled
                  ? "border-gray-100 bg-gray-50 opacity-70 cursor-not-allowed"
                  : "border-gray-200 bg-surface hover:border-gray-400"
              }`}
            >
              <p className="text-sm font-medium">{PRESET_LABEL[preset]}</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                {PRESET_DESCRIPTION[preset]}
              </p>
              {reason && (
                <p className="text-[10px] font-mono uppercase tracking-wider text-amber-600">
                  {reason}
                </p>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
