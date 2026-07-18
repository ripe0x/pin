"use client"

import { useRef } from "react"
import { KNOWN_DEPENDENCIES } from "@/lib/create-collection"
import type { WizardState } from "./types"
import { LABEL, TEXTAREA, INPUT, HELP, BTN_SECONDARY } from "./wizard-ui"

type Setter = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void

export function GenerativeFields({
  state,
  set,
  disabled,
}: {
  state: WizardState
  set: Setter
  disabled: boolean
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    set("script", text)
    set("scriptFileName", file.name)
  }

  function toggleDep(id: string) {
    const next = state.selectedDeps.includes(id)
      ? state.selectedDeps.filter((d) => d !== id)
      : [...state.selectedDeps, id]
    set("selectedDeps", next)
  }

  return (
    <div className="space-y-5">
      <div>
        <label className={LABEL} htmlFor="cc-cover">
          Cover art URI (optional)
        </label>
        <input
          id="cc-cover"
          className={INPUT}
          value={state.artworkURI}
          onChange={(e) => set("artworkURI", e.target.value.trim())}
          placeholder="ipfs://…"
          disabled={disabled}
        />
        <p className={HELP}>
          Shown as the static image alongside the live render. Optional: the
          generative output is the artwork.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className={LABEL} htmlFor="cc-script">
            Script
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".js,text/javascript"
              className="hidden"
              onChange={onFilePicked}
              disabled={disabled}
            />
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
            >
              Upload .js file
            </button>
          </div>
        </div>
        <textarea
          id="cc-script"
          className={TEXTAREA}
          value={state.script}
          onChange={(e) => {
            set("script", e.target.value)
            set("scriptFileName", null)
          }}
          rows={14}
          placeholder={
            "function setup() {\n  createCanvas(600, 600)\n}\n\nfunction draw() {\n  background(tokenData.hash)\n}"
          }
          disabled={disabled}
          spellCheck={false}
        />
        {state.scriptFileName && (
          <p className={HELP}>Loaded from {state.scriptFileName}</p>
        )}
        <p className={HELP}>
          Reads window.tokenData for its seed (hash, tokenId,
          collection, chainId, version). Stored onchain as raw JS, unmodified.
        </p>
      </div>

      <div>
        <label className={LABEL}>Dependencies</label>
        <div className="space-y-2">
          {KNOWN_DEPENDENCIES.map((dep) => (
            <label key={dep.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={state.selectedDeps.includes(dep.id)}
                onChange={() => toggleDep(dep.id)}
                disabled={disabled}
              />
              <span className="text-[11px] font-mono text-gray-600">{dep.label}</span>
              {!dep.verified && (
                <span className="text-[9px] font-mono uppercase tracking-wider text-amber-600 border border-amber-300 px-1 rounded">
                  unverified on this fork
                </span>
              )}
            </label>
          ))}
        </div>
        <p className={HELP}>
          Onchain gzipped library files from the EthFS store, loaded before your
          script runs.
        </p>
      </div>

      <div>
        <label className={LABEL} htmlFor="cc-render-params">
          Render params (optional)
        </label>
        <input
          id="cc-render-params"
          className={INPUT}
          value={state.renderParams}
          onChange={(e) => set("renderParams", e.target.value)}
          placeholder="aspect=1:1;fps=30"
          disabled={disabled}
        />
        <p className={HELP}>
          Renderer-interpreted settings (aspect ratio, declared onchain reads for
          onchain-live works, etc). Freeform, stored as-is.
        </p>
      </div>
    </div>
  )
}
