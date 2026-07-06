"use client"

import { isAddress } from "viem"
import type { WizardState } from "./types"
import { LABEL, INPUT, HELP, ERROR } from "./wizard-ui"

type Setter = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void

export function RendererFields({
  state,
  set,
  disabled,
}: {
  state: WizardState
  set: Setter
  disabled: boolean
}) {
  const rendererOk = state.customRenderer !== "" && isAddress(state.customRenderer)
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 leading-relaxed">
        The renderer contract is the artwork: it implements tokenURI itself, reading
        this collection&rsquo;s onchain state directly. There is no script and no
        WorkConfig to fill in here.
      </p>
      <div>
        <label className={LABEL} htmlFor="cc-renderer">
          Renderer contract address
        </label>
        <input
          id="cc-renderer"
          className={INPUT}
          value={state.customRenderer}
          onChange={(e) => set("customRenderer", e.target.value.trim())}
          placeholder="0x…"
          disabled={disabled}
        />
        {state.customRenderer !== "" && !rendererOk && (
          <p className={ERROR}>Invalid address</p>
        )}
        <p className={HELP}>
          Must implement IRenderer.tokenURI(collection, tokenId). Deployed and
          verified separately, then pointed at here.
        </p>
      </div>
    </div>
  )
}
