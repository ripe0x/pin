"use client"

import { isAddress } from "viem"
import type { UseEthAmountInputResult } from "@/lib/useEthAmountInput"
import type { WizardState } from "./types"
import {
  IdentityFields,
  PriceSupplyWindowFields,
  RoyaltyPayoutFields,
  CollaboratorFields,
  validateCollaborators,
} from "./SharedFields"
import { GenerativeFields } from "./GenerativeFields"
import { RendererFields } from "./RendererFields"
import { LABEL, INPUT, HELP, ERROR, BTN } from "./wizard-ui"

type Setter = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void

export function ConfigStep({
  state,
  set,
  price,
  disabled,
  onNext,
}: {
  state: WizardState
  set: Setter
  price: UseEthAmountInputResult
  disabled: boolean
  onNext: () => void
}) {
  if (!state.preset) return null

  const collabCheck = validateCollaborators(state.collaborators)
  const royaltyBps = Math.round(Number(state.royaltyPct || "0") * 100)
  const royaltyOk = royaltyBps >= 0 && royaltyBps <= 5_000
  const capOk =
    state.openSupply || (Number(state.supplyCap) > 0 && Number.isFinite(Number(state.supplyCap)))
  const payoutOk = state.payout === "" || isAddress(state.payout)

  const identityOk = state.name.trim().length > 0 && state.symbol.trim().length > 0
  const priceOk = price.isEmpty || price.isValid

  let presetOk = true
  if (state.preset === "edition") {
    presetOk = state.artworkURI.trim().length > 0
  } else if (state.preset === "generative") {
    presetOk = state.script.trim().length > 0
  } else if (state.preset === "renderer") {
    presetOk = state.customRenderer.trim() !== "" && isAddress(state.customRenderer)
  }

  // Every preset sells through the same built-in paid path; renderer-native
  // works differ only in where the artwork comes from, not in economics.
  const canProceed =
    identityOk && presetOk && priceOk && royaltyOk && capOk && payoutOk && collabCheck.ok

  return (
    <div className="space-y-5">
      <IdentityFields state={state} set={set} disabled={disabled} />

      {state.preset === "edition" && (
        <div>
          <label className={LABEL} htmlFor="cc-art">
            Artwork URI
          </label>
          <input
            id="cc-art"
            className={INPUT}
            value={state.artworkURI}
            onChange={(e) => set("artworkURI", e.target.value.trim())}
            placeholder="ipfs://…"
            disabled={disabled}
          />
          <p className={HELP}>
            The shared art for this edition. ipfs:// recommended. PND can pin it via
            Preserve.
          </p>
        </div>
      )}

      {state.preset === "generative" && (
        <GenerativeFields state={state} set={set} disabled={disabled} />
      )}

      {state.preset === "renderer" && (
        <RendererFields state={state} set={set} disabled={disabled} />
      )}

      <PriceSupplyWindowFields state={state} set={set} price={price} disabled={disabled} />
      <RoyaltyPayoutFields state={state} set={set} disabled={disabled} />
      <CollaboratorFields state={state} set={set} disabled={disabled} />

      {!identityOk && (
        <p className={ERROR}>Name and symbol are required.</p>
      )}

      <button onClick={onNext} disabled={!canProceed || disabled} className={BTN}>
        Continue
      </button>
    </div>
  )
}
