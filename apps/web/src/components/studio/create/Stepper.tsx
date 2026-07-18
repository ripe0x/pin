"use client"

import type { StepId } from "./types"

const STEP_LABEL: Record<StepId, string> = {
  preset: "Type",
  config: "Configure",
  preview: "Preview",
  upload: "Upload",
  deploy: "Deploy",
}

export function Stepper({ steps, current }: { steps: StepId[]; current: StepId }) {
  const currentIndex = steps.indexOf(current)
  return (
    <ol className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
      {steps.map((step, i) => {
        const done = i < currentIndex
        const active = step === current
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 ${
                active ? "text-fg" : done ? "text-gray-500" : "text-gray-300"
              }`}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${
                  active
                    ? "border-fg bg-fg text-bg"
                    : done
                      ? "border-gray-400 text-gray-500"
                      : "border-gray-200 text-gray-300"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              {STEP_LABEL[step]}
            </span>
            {i < steps.length - 1 && <span className="text-gray-200">{"/"}</span>}
          </li>
        )
      })}
    </ol>
  )
}
